(() => {
  "use strict";

  const names = {
    quote: "Quote",
    work_order: "Work Order",
    purchase_order: "Purchase Order"
  };
  const roots = {
    quote: "commercial-quote-root",
    work_order: "commercial-work-order-root",
    purchase_order: "commercial-purchase-order-root"
  };
  const state = {
    workspace: null,
    kind: "quote",
    model: null,
    editor: null,
    busy: false,
    dirty: false,
    changed: false,
    search: "",
    sort: "Most recently saved",
    hidden: new Set(),
    revision: 0
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const currentWorkspace = () => window.CeasefireCertification?.sessionId?.();
  const root = () => document.getElementById(roots[state.kind]);
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function button(label, action, primary = false) {
    const element = node("button", primary ? "button primary" : "button secondary", label);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }
  function field(label, control) {
    const wrapper = node("label", "field");
    control.setAttribute("aria-label", label);
    wrapper.append(node("span", "", label), control);
    return wrapper;
  }
  function input(value, changed, type = "text") {
    const element = node("input");
    element.type = type;
    element.value = value ?? "";
    element.addEventListener("input", () => {
      changed(element.value);
      markDirty();
    });
    return element;
  }
  function select(options, value, changed, dirty = true) {
    const element = node("select");
    options.forEach(item => {
      const option = node("option", "", item);
      option.value = item;
      element.append(option);
    });
    element.value = value;
    element.addEventListener("change", () => {
      changed(element.value);
      if (dirty) markDirty();
    });
    return element;
  }
  function textarea(value, changed) {
    const element = node("textarea");
    element.value = value || "";
    element.rows = 3;
    element.addEventListener("input", () => {
      changed(element.value);
      markDirty();
    });
    return element;
  }
  function message(text, error = false) {
    const element = root()?.querySelector(".commercial-message");
    if (element) {
      element.textContent = text;
      element.hidden = !text;
      element.classList.toggle("error", error);
    }
  }
  function markDirty() {
    state.dirty = true;
    if (state.editor) state.editor.pendingIssue = null;
    window.CeasefireProject?.changed?.();
  }
  function positionCardMenu(menu) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      const panel = menu.querySelector(".commercial-menu-options");
      const rect = menu.querySelector("summary").getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, rect.right - panel.offsetWidth))}px`;
      panel.style.top = `${rect.bottom + panel.offsetHeight + 12 <= innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - panel.offsetHeight - 6)}px`;
    });
  }
  function changed() {
    state.changed = true;
    window.CeasefireProject?.changed?.();
  }
  async function request(action, body) {
    const response = await fetch(`/api/commercial/${action}`, body === undefined ? {
      cache: "no-store"
    } : {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The commercial document request failed.");
    return result;
  }
  function today() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  function scaledDecimal(value) {
    const match = String(value).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match || !(match[2] || match[3])) return 0n;
    const fraction = match[3] || "";
    const power = 6 + Number(match[4] || 0) - fraction.length;
    if (!Number.isInteger(power) || Math.abs(power) > 24) return 0n;
    let amount = BigInt((match[2] || "0") + fraction);
    amount = power >= 0 ? amount * 10n ** BigInt(power) : amount / 10n ** BigInt(-power);
    return match[1] === "-" ? -amount : amount;
  }
  function roundFraction(amount, divisor) {
    const negative = amount < 0n;
    const rounded = ((negative ? -amount : amount) + divisor / 2n) / divisor;
    return negative ? -rounded : rounded;
  }
  function summary(fields) {
    const rows = fields.lines.map(line => roundFraction(scaledDecimal(line.quantity) * scaledDecimal(line.unit_price), 10000000000n));
    const subtotal = rows.reduce((sum, value) => sum + value, 0n);
    const gst = roundFraction(subtotal, 10n);
    const money = value => {
      const amount = value < 0n ? -value : value;
      return `${value < 0n ? "-" : ""}$${(amount / 100n).toLocaleString("en-AU")}.${String(amount % 100n).padStart(2, "0")}`;
    };
    return {
      rows,
      subtotal,
      gst,
      total: subtotal + gst,
      money
    };
  }
  function shell(title) {
    const host = root();
    host.replaceChildren();
    const heading = node("div", "page-heading");
    heading.append(node("h1", "", title));
    host.append(heading);
    const notice = node("p", "commercial-message message");
    notice.setAttribute("role", "status");
    notice.hidden = true;
    host.append(notice);
    return host;
  }
  async function load(revision = ++state.revision) {
    const workspace = state.workspace;
    const context = window.CeasefireProject?.runtimeContext?.();
    const result = await request(`state?workspace=${encodeURIComponent(workspace)}`);
    if (revision !== state.revision || workspace !== state.workspace || workspace !== currentWorkspace() || context !== window.CeasefireProject?.runtimeContext?.()) return false;
    state.model = result;
    return true;
  }
  async function activate(kind) {
    if (!names[kind]) return;
    if (state.busy || state.dirty) {
      message("Save or discard the current document before changing pages.", true);
      return;
    }
    const revision = ++state.revision;
    const context = window.CeasefireProject?.runtimeContext?.();
    state.kind = kind;
    if (!root()) return;
    shell(names[kind] + (kind === "quote" ? "" : "s"));
    try {
      const workspace = currentWorkspace() || (await window.CeasefireCertification.projectWorkspace()).workspace_id;
      if (revision !== state.revision || context !== window.CeasefireProject?.runtimeContext?.() || workspace !== currentWorkspace()) return;
      if (workspace !== state.workspace) {
        state.workspace = workspace;
        state.model = null;
        state.editor = null;
        state.changed = false;
      }
      if (await load(revision)) renderBoard();
    } catch (error) {
      if (revision === state.revision && context === window.CeasefireProject?.runtimeContext?.()) message(error.message, true);
    }
  }
  function renderBoard() {
    state.editor = null;
    state.dirty = false;
    const host = shell(names[state.kind] + "s"),
      controls = node("div", "commercial-controls");
    const search = node("input");
    search.type = "search";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      renderCards();
    });
    search.placeholder = "Document, client, project or reference…";
    controls.append(field("Search documents", search));
    const sort = select(["Most recently saved", "Oldest saved first", "Document name A–Z"], state.sort, value => {
      state.sort = value;
      state.dirty = false;
      renderCards();
    }, false);
    const sortField = field("Sort by", sort);
    sort.addEventListener("change", () => { state.dirty = false; });
    sortField.classList.add("commercial-sort");
    controls.append(sortField, button("New " + names[state.kind], () => openNew(), true));
    const columns = node("details", "commercial-columns-menu");
    columns.append(node("summary", "button secondary", "Columns ▾"));
    const columnOptions = node("div", "commercial-menu-options");
    for (const status of state.model.statuses[state.kind]) {
      const label = node("label", "commercial-check"),
        checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = !state.hidden.has(status);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.hidden.delete(status);else state.hidden.add(status);
        renderCards();
      });
      label.append(checkbox, node("span", "", status));
      columnOptions.append(label);
    }
    columns.append(columnOptions);
    controls.append(columns);
    const list = node("section", "card commercial-list");
    list.append(controls, node("p", "helper commercial-match-count"), node("div", "commercial-board project-kanban"));
    host.append(list);
    renderCards();
  }
  function renderCards() {
    const board = root()?.querySelector(".commercial-board");
    if (!board) return;
    board.replaceChildren();
    const all = state.model.documents.filter(document => document.kind === state.kind);
    const documents = all.filter(document => `${document.fields.title} ${document.fields.details.client} ${document.fields.details.project_no} ${document.last_number} ${document.fields.order.work_order_reference}`.toLowerCase().includes(state.search.toLowerCase()));
    documents.sort((a, b) => state.sort === "Document name A–Z"
      ? a.fields.title.localeCompare(b.fields.title, "en", {numeric:true}) || a.id.localeCompare(b.id)
      : (state.sort === "Oldest saved first" ? 1 : -1) * a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
    root().querySelector(".commercial-match-count").textContent = `${documents.length} matching documents · ${all.length} found`;
    for (const status of state.model.statuses[state.kind]) {
      if (state.hidden.has(status)) continue;
      const column = node("section", "commercial-column project-kanban-column");
      column.dataset.status = status;
      column.setAttribute("aria-label", status);
      const matches = documents.filter(document => document.status === status);
      const columnHeading = node("div", "project-column-heading");
      columnHeading.append(node("h2", "", status), node("span", "status-label", matches.length));
      column.append(columnHeading);
      column.addEventListener("dragover", event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      column.addEventListener("drop", event => {
        event.preventDefault();
        const identity = event.dataTransfer.getData("text/plain");
        const document = documents.find(item => item.id === identity);
        if (document) void move(document, status);
      });
      for (const document of matches) {
        const card = node("article", "commercial-card project-kanban-card");
        card.draggable = true;
        card.addEventListener("dragstart", event => {
          if (state.busy || event.target.closest("button,select,summary,input")) { event.preventDefault(); return; }
          event.dataTransfer.setData("text/plain", document.id);
          event.dataTransfer.effectAllowed = "move";
        });
        const menu = node("details", "commercial-card-menu");
        const toggle = node("summary", "", "▾");
        toggle.setAttribute("aria-label", `Actions for ${document.fields.title}`);
        const actions = node("div", "commercial-menu-options");
        for (const [label, action] of [["Open", () => openEditor(document)], ["Edit", () => openEditor(document)], ["Delete", () => remove(document)]]) {
          const control = button(label, () => { menu.open = false; if (!state.busy) action(); });
          control.className = "text-button";
          actions.append(control);
        }
        const statusSelect = select(state.model.statuses[state.kind], document.status, value => void move(document, value), false);
        statusSelect.addEventListener("change", () => {
          state.dirty = false;
          menu.open = false;
        });
        actions.append(field("Move to", statusSelect));
        menu.append(toggle, actions);
        positionCardMenu(menu);
        const title = button(document.fields.title, () => { if (!state.busy) openEditor(document); });
        title.className = "project-title-button";
        const heading = node("div", "project-card-heading");
        heading.append(title, menu);
        card.append(heading, node("p", "helper", document.fields.order.work_order_reference && state.kind === "work_order" ? document.fields.order.work_order_reference : document.last_number || "Number assigned on PDF download"), node("p", "helper", [document.fields.details.project_no, document.fields.details.client].filter(Boolean).join(" · ")), node("p", "helper", "Last updated " + new Date(document.updated_at).toLocaleString("en-AU")));
        column.append(card);
      }
      if (!matches.length) column.append(node("p", "project-column-empty", "No documents"));
      board.append(column);
    }
    if (!board.children.length) board.append(node("p", "empty-state", "Choose a column from Columns to show documents."));
  }
  async function move(document, status) {
    if (state.busy) return;
    state.busy = true;
    try {
      await request("status", {
        workspace_id: state.workspace,
        id: document.id,
        version: document.version,
        status
      });
      changed();
      await load();
      renderBoard();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  async function remove(document) {
    if (state.busy || !window.confirm(`Delete “${document.fields.title}”?`)) return;
    state.busy = true;
    try {
      await request("delete", {
        workspace_id: state.workspace,
        id: document.id,
        version: document.version
      });
      changed();
      await load();
      renderBoard();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  async function openNew(fromEstimate = false) {
    if (state.busy) return;
    state.busy = true;
    try {
      const details = {
        ...window.CeasefireProject?.details?.(),
        date: today()
      };
      const result = await request("defaults", {
        workspace_id: state.workspace,
        kind: state.kind,
        details
      });
      const document = {
        id: crypto.randomUUID(),
        version: 0,
        kind: state.kind,
        status: "Draft",
        fields: result.fields,
        last_number: ""
      };
      openEditor(document);
      state.dirty = true;
      const estimateId = window.CeasefireEstimates?.activeId?.() || "estimate-1";
      if ((state.kind === "quote" || fromEstimate) && !(await refreshEstimates([estimateId]))) return;
      if (fromEstimate && state.kind !== "quote") {
        const fields = state.editor.document.fields;
        const eligible = state.model.documents.filter(item => item.kind === "quote" && item.last_number && item.fields.sources?.some(source => source.id === estimateId || source.estimate_id === estimateId));
        if (eligible.length === 1) fields.order.quote_id = eligible[0].id;
        if (state.kind === "work_order") {
          fields.order.description = fields.lines.map(line => line.description).join("\n");
          fields.order.estimated_cost = (Number(summary(fields).subtotal) / 100).toFixed(2);
        } else {
          fields.order.ship_to_address = fields.details.site_address;
          const workOrders = state.model.documents.filter(item => item.kind === "work_order" && item.fields.order.work_order_reference && eligible.some(quote => quote.id === item.fields.order.quote_id));
          if (workOrders.length === 1) {
            fields.order.work_order_id = workOrders[0].id;
            fields.order.work_order_reference = workOrders[0].fields.order.work_order_reference;
          }
        }
        const draft = copy(state.editor.document);
        state.dirty = false;
        openEditor(draft);
        markDirty();
      }
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  function richEditor(label, value, changedValue) {
    const section = node("section", "commercial-rich"),
      toolbar = node("div", "commercial-rich-toolbar"),
      editor = node("div", "commercial-rich-input");
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-label", label);
    editor.innerHTML = value;
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", `${label} formatting`);
    const formats = [
      ["Bold", "bold", "M6 4h8a4 4 0 0 1 0 8H6z M6 12h9a4 4 0 0 1 0 8H6z"],
      ["Italic", "italic", "M19 4h-9 M14 20H5 M15 4 9 20"],
      ["Underline", "underline", "M6 3v7a6 6 0 0 0 12 0V3 M4 21h16"],
      ["Bullets", "insertUnorderedList", "M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01"],
      ["Numbered list", "insertOrderedList", "M10 6h11 M10 12h11 M10 18h11 M3 4h1v5 M3 9h2 M2 14a2 2 0 0 1 4 0c0 1-1 2-4 5h4"]
    ];
    for (const [text, command, path] of formats) {
      const control = button("", () => {
        editor.focus();
        document.execCommand("styleWithCSS", false, false);
        document.execCommand(command, false);
        changedValue(editor.innerHTML);
        markDirty();
      });
      control.classList.add("commercial-format-button");
      control.setAttribute("aria-label", text);
      control.title = text;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "path");
      glyph.setAttribute("d", path);
      icon.append(glyph);
      control.append(icon);
      control.addEventListener("mousedown", event => event.preventDefault());
      toolbar.append(control);
    }
    editor.addEventListener("input", () => {
      changedValue(editor.innerHTML);
      markDirty();
    });
    editor.addEventListener("paste", event => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    section.append(node("h2", "", label), toolbar, editor);
    return section;
  }
  function openEditor(document) {
    if (state.dirty && !window.confirm("Discard the unsaved document changes?")) return;
    state.editor = {
      document: copy(document),
      pendingIssue: null,
      generatedScope: null,
      scopeTables: copy(document.fields.scope_tables || []),
      scopeRevision: 0
    };
    state.dirty = false;
    const host = shell(names[state.kind]),
      form = node("div", "commercial-editor"),
      fields = state.editor.document.fields;
    const actions = node("div", "commercial-editor-actions");
    actions.append(button("Back to " + names[state.kind] + "s", () => {
      if (!state.dirty || window.confirm("Discard unsaved changes?")) {
        state.dirty = false;
        renderBoard();
      }
    }), button("Save", () => void saveEditor(), true), button("Download PDF", () => void downloadEditor(), true));
    const titleRow = node("div", "commercial-title-row");
    titleRow.append(field("Document title", input(fields.title, value => fields.title = value)), field("Status", select(state.model.statuses[state.kind], state.editor.document.status, value => state.editor.document.status = value)));
    form.append(actions, titleRow);
    const details = node("section", "card commercial-details");
    details.append(node("h2", "", "Project details"));
    for (const [key, label] of [["project_no", "Project number"], ["client", "Client"], ["site_address", "Site address"], ["contact", "Client contact"], ["phone", "Client phone"], ["email", "Client email"], ["date", "Document date"]]) {
      if (state.kind === "purchase_order" && ["client", "contact", "phone", "email"].includes(key)) continue;
      const control = input(fields.details[key], value => fields.details[key] = value, key === "date" ? "date" : "text");
      if (key === "project_no" && state.kind === "work_order" && document.version > 0 && fields.order.work_order_reference) control.readOnly = true;
      details.append(field(label, control));
    }
    form.append(details);
    if (state.kind === "quote") {
      form.append(field("Introduction", textarea(fields.introduction, value => fields.introduction = value)));
      const chooser = node("details", "commercial-estimate-picker");
      chooser.append(node("summary", "button secondary", "Select estimates"), node("div", "commercial-estimate-options"));
      form.append(chooser);
      form.append(node("section", "commercial-lines"), node("div", "commercial-totals"), node("section", "commercial-scope"), richEditor("Scope preamble", fields.scope, value => fields.scope = value), richEditor("Allowances", fields.allowances, value => fields.allowances = value), richEditor("Terms & Conditions", fields.terms, value => fields.terms = value));
    } else {
      renderOrderFields(form, fields);
      if (state.kind === "purchase_order") form.append(node("section", "commercial-lines"), button("Add line item", () => {
        fields.lines.push({
          estimate_id: "",
          description: "",
          quantity: "1",
          unit_price: "0",
          size: "",
          comments: ""
        });
        markDirty();
        renderLines();
      }), node("div", "commercial-totals"));
    }
    host.append(form);
    if (state.kind === "quote") {
      renderEstimateOptions();
      renderScope();
    }
    renderLines();
    if (state.kind === "quote" && document.version > 0) void refreshScopePreview();
  }
  function renderOrderFields(form, fields) {
    const references = node("section", "commercial-linked-reference");
    const isWorkOrder = state.kind === "work_order";
    const linkKey = isWorkOrder ? "quote_id" : "work_order_id";
    const choices = state.model.documents.filter(item => isWorkOrder
      ? item.kind === "quote" && item.last_number
      : item.kind === "work_order" && item.fields.order.work_order_reference);
    const linked = node("select");
    const blank = node("option", "", isWorkOrder ? "Select an issued Quote…" : "No Work Order linked");
    blank.value = "";
    linked.append(blank);
    for (const item of choices) {
      const quoteNumber = state.editor.document.version > 0 && fields.order.quote_id === item.id && fields.order.work_order_reference ? fields.order.quote_reference : item.last_number;
      const option = node("option", "", `${isWorkOrder ? quoteNumber : item.fields.order.work_order_reference} · ${item.fields.title}`);
      option.value = item.id;
      linked.append(option);
    }
    if (fields.order[linkKey] && !choices.some(item => item.id === fields.order[linkKey])) {
      const retained = node("option", "", isWorkOrder ? fields.order.quote_reference : fields.order.work_order_reference);
      retained.value = fields.order[linkKey];
      linked.append(retained);
    }
    linked.value = fields.order[linkKey] || "";
    linked.dataset.orderLink = linkKey;
    linked.disabled = isWorkOrder && state.editor.document.version > 0 && !!fields.order.work_order_reference;
    const reference = input(fields.order.work_order_reference, () => {});
    reference.readOnly = true;
    reference.placeholder = isWorkOrder ? "Assigned when this Work Order is saved" : "Select a linked Work Order";
    reference.dataset.orderReference = "true";
    linked.addEventListener("change", () => {
      fields.order[linkKey] = linked.value;
      const selected = choices.find(item => item.id === linked.value);
      if (isWorkOrder) fields.order.quote_reference = selected?.last_number || "";
      else {
        fields.order.work_order_reference = selected?.fields.order.work_order_reference || "";
        reference.value = fields.order.work_order_reference;
      }
      markDirty();
    });
    references.append(field(isWorkOrder ? "Linked Quote" : "Linked Work Order", linked), field("Work order reference", reference));
    form.append(references);
    const commonReview = [["approval", "Approval"], ["reviewed_by", "Reviewed by"], ["review_date", "Review date"]];
    const groups = state.kind === "work_order" ? [["Work order details", [["start_date", "Proposed start date"], ["end_date", "Proposed end date"], ["urgency", "Category / urgency"], ["quote_reference", "Quote reference"], ["description", "Description of works"], ["estimated_cost", "Estimated cost (AUD)"], ["attachments", "Image / video references"]]], ["Work order review", [...commonReview, ["justification", "Justification"]]], ["OHS documentation", [["swms", "SWMS"], ["sds", "SDS"], ["sop", "SOP"], ["other_documents", "Other documents"], ["prepared_by", "Prepared by"]]], ["Client approval", [["client_approval", "Safety documentation approval"], ["client_approved_by", "Approved by"], ["client_approval_date", "Approval date"]]], ["Progress and completion", [["progress", "Work progress"], ["claim", "Products and services charged"], ["certification", "Certification details"], ["completion", "Completion"], ["closed_by", "Closed by"]]]] : [["Purchase order information", [["work_order_reference", "Work order reference"], ["supplier", "Supplier"], ["supplier_email", "Supplier email"], ["supplier_contact", "Supplier contact"], ["payment_terms", "Payment terms"], ["ship_to_name", "Ship to name"], ["ship_to_address", "Ship to address"], ["delivery_date", "Delivery date"], ["expense_type", "Type of expense"], ["delivery_method", "Delivery or pickup"]]], ["Request and approval", [["requested_by", "Requested by"], ["requested_date", "Request date"], ...commonReview]], ["Procurement verification", [["verification", "Verification method, specification, result and actions"], ["sent_by", "Sent by"], ["sent_date", "Sent date"], ["verified_by", "Verified by"], ["verified_date", "Verification date"]]]];
    for (const [title, items] of groups) {
      const section = node("section", "card commercial-order-fields");
      section.append(node("h2", "", title));
      for (const [key, label] of items) {
        if (["quote_reference", "work_order_reference"].includes(key)) continue;
        section.append(field(label, key.endsWith("_date") ? input(fields.order[key], value => fields.order[key] = value, "date") : textarea(fields.order[key], value => fields.order[key] = value)));
      }
      form.append(section);
    }
  }
  function renderEstimateOptions() {
    const container = root()?.querySelector(".commercial-estimate-options");
    if (!container) return;
    container.replaceChildren();
    const selected = new Set(state.editor.document.fields.lines.map(line => line.estimate_id));
    for (const estimate of window.CeasefireEstimates?.list?.() || [{
      id: "estimate-1",
      name: "Current estimate"
    }]) {
      const label = node("label", "commercial-check"),
        checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(estimate.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(estimate.id);else selected.delete(estimate.id);
        void refreshEstimates([...selected]);
      });
      label.append(checkbox, node("span", "", estimate.name));
      container.append(label);
    }
  }
  async function capturedEstimates(options) {
    if (!window.CeasefireEstimates?.capture) throw new Error("The project estimate workspace is unavailable.");
    return window.CeasefireEstimates.capture(options);
  }
  async function refreshScopePreview() {
    const editor = state.editor;
    const workspace = state.workspace;
    const context = window.CeasefireProject?.runtimeContext?.();
    const revision = ++editor.scopeRevision;
    const current = () => editor === state.editor && revision === editor.scopeRevision
      && workspace === state.workspace && workspace === currentWorkspace()
      && context === window.CeasefireProject?.runtimeContext?.();
    try {
      const captured = await capturedEstimates({readOnly:true});
      if (!current()) return;
      const derived = await request("derive", {
        workspace_id: workspace,
        ...captured,
        selected_ids: editor.document.fields.lines.map(line => line.estimate_id)
      });
      if (!current()) return;
      editor.scopeTables = derived.scope_tables;
      renderScope();
    } catch (error) {
      if (current()) message("The scope preview could not be refreshed. " + error.message, true);
    }
  }
  async function refreshEstimates(selectedIds) {
    const editor = state.editor;
    if (!editor) return false;
    const workspace = state.workspace;
    const context = window.CeasefireProject?.runtimeContext?.();
    ++editor.scopeRevision;
    state.busy = true;
    setDisabled(true);
    message("Updating linked estimates…");
    try {
      const captured = await capturedEstimates();
      if (editor !== state.editor || workspace !== state.workspace || context !== window.CeasefireProject?.runtimeContext?.()) return;
      const derived = await request("derive", {
        workspace_id: workspace,
        ...captured,
        selected_ids: selectedIds
      });
      if (editor !== state.editor || workspace !== state.workspace || workspace !== currentWorkspace() || context !== window.CeasefireProject?.runtimeContext?.()) return;
      const fields = editor.document.fields,
        previous = new Map(fields.lines.map(line => [line.estimate_id, line]));
      fields.lines = derived.lines.map(line => ({
        ...line,
        size: "",
        comments: "",
        ...(previous.has(line.estimate_id) ? {
          description: previous.get(line.estimate_id).description,
          quantity: previous.get(line.estimate_id).quantity
        } : {})
      }));
      fields.scope_tables = derived.scope_tables;
      editor.scopeTables = derived.scope_tables;
      fields.sources = derived.sources;
      if (!fields.scope || fields.scope === editor.generatedScope) fields.scope = derived.scope;
      editor.generatedScope = derived.scope;
      const preamble = root()?.querySelector('.commercial-rich-input[aria-label="Scope preamble"]');
      if (preamble && fields.scope === derived.scope) preamble.innerHTML = derived.scope;
      markDirty();
      renderEstimateOptions();
      renderLines();
      renderScope();
      message("");
      return true;
    } catch (error) {
      message(error.message, true);
      renderEstimateOptions();
      return false;
    } finally {
      state.busy = false;
      setDisabled(false);
    }
  }
  function renderLines() {
    const host = root()?.querySelector(".commercial-lines");
    if (!host || !state.editor) return;
    host.replaceChildren(node("h2", "", state.kind === "quote" ? "Quote summary" : "Request summary"));
    const fields = state.editor.document.fields,
      table = node("table"),
      head = node("thead"),
      header = node("tr");
    for (const label of ["Product / Service", "Quantity", "Unit price", "Total", ...(state.kind === "purchase_order" ? ["Size", "Comments", "Actions"] : [])]) header.append(node("th", "", label));
    head.append(header);
    table.append(head);
    const body = node("tbody");
    fields.lines.forEach((line, index) => {
      const row = node("tr"),
        description = node("td"),
        quantity = node("td"),
        unit = node("td"),
        total = node("td", "commercial-line-total");
      const descriptionInput = textarea(line.description, value => line.description = value);
      descriptionInput.rows = 1;
      descriptionInput.classList.add("commercial-line-description");
      descriptionInput.setAttribute("aria-label", `Product / Service ${index + 1}`);
      const resize = () => resizeDescription(descriptionInput);
      descriptionInput.addEventListener("input", resize);
      description.append(descriptionInput);
      requestAnimationFrame(resize);
      quantity.append(input(line.quantity, value => {
        line.quantity = value;
        renderTotals();
      }, "number"));
      quantity.querySelector("input").min = "0";
      quantity.querySelector("input").step = "any";
      const price = input(line.unit_price, value => {
        line.unit_price = value;
        renderTotals();
      }, "number");
      price.min = "-1000000000";
      price.step = "any";
      price.readOnly = state.kind === "quote";
      unit.append(price);
      row.append(description, quantity, unit, total);
      if (state.kind === "purchase_order") {
        const size = node("td"),
          comments = node("td"),
          actions = node("td");
        size.append(input(line.size, value => line.size = value));
        comments.append(textarea(line.comments, value => line.comments = value));
        actions.append(button("Remove", () => {
          fields.lines.splice(index, 1);
          markDirty();
          renderLines();
        }));
        row.append(size, comments, actions);
      }
      body.append(row);
    });
    table.append(body);
    const scroll = node("div", "table-scroll");
    scroll.append(table);
    host.append(scroll);
    renderTotals();
  }
  function resizeDescription(control) {
    if (!control.isConnected || !control.getBoundingClientRect().width) return;
    control.style.height = "auto";
    control.style.height = `${Math.max(42, control.scrollHeight + 2)}px`;
  }
  function renderTotals() {
    if (!state.editor) return;
    const totals = summary(state.editor.document.fields),
      host = root()?.querySelector(".commercial-totals");
    root()?.querySelectorAll(".commercial-line-total").forEach((cell, index) => cell.textContent = totals.money(totals.rows[index]));
    if (host) {
      host.replaceChildren();
      for (const [label, value] of [["Subtotal", totals.subtotal], ["GST (10%)", totals.gst], ["Grand total", totals.total]]) {
        const line = node("p");
        line.append(node("strong", "", label), node("span", "", totals.money(value)));
        host.append(line);
      }
    }
  }
  function renderScope() {
    const host = root()?.querySelector(".commercial-scope");
    if (!host) return;
    host.replaceChildren(node("h2", "", "Scope of Works"));
    host.append(node("p", "helper", "The PDF includes the complete Full Schedule for every selected estimate."));
    for (const scope of state.editor.scopeTables) {
      const details = node("details"),
        table = node("table"),
        head = node("thead"),
        header = node("tr");
      details.append(node("summary", "", scope.title));
      scope.headers.forEach(text => header.append(node("th", "", text)));
      head.append(header);
      table.append(head);
      const body = node("tbody");
      scope.rows.forEach(values => {
        const row = node("tr");
        values.forEach(value => row.append(node("td", "", value)));
        body.append(row);
      });
      table.append(body);
      const scroll = node("div", "table-scroll");
      scroll.append(table);
      details.append(scroll);
      host.append(details);
    }
  }
  function setDisabled(disabled) {
    root()?.querySelectorAll(".commercial-editor button,.commercial-editor input,.commercial-editor textarea,.commercial-editor select").forEach(control => control.disabled = disabled);
    root()?.querySelectorAll(".commercial-rich-input").forEach(control => control.contentEditable = String(!disabled));
    if (!disabled && state.kind === "work_order" && state.editor?.document.version > 0 && state.editor.document.fields.order.work_order_reference) {
      const linked = root()?.querySelector('[data-order-link="quote_id"]');
      if (linked) linked.disabled = true;
      const number = root()?.querySelector('input[aria-label="Project number"]');
      if (number) number.readOnly = true;
    }
  }
  async function persist(captured) {
    const document = state.editor.document;
    const saved = await request("save", {
      workspace_id: state.workspace,
      id: document.id,
      version: document.version,
      kind: document.kind,
      status: document.status,
      fields: document.fields,
      ...captured
    });
    adoptSaved(saved);
    state.dirty = false;
    changed();
    await load();
    return saved;
  }
  function adoptSaved(saved) {
    const fields = state.editor.document.fields;
    ++state.editor.scopeRevision;
    Object.assign(fields, saved.fields);
    state.editor.scopeTables = copy(fields.scope_tables || []);
    Object.assign(state.editor.document, saved, {
      fields
    });
    renderLines();
    renderScope();
    const reference = root()?.querySelector("[data-order-reference]");
    if (reference) reference.value = fields.order.work_order_reference;
  }
  async function saveEditor() {
    if (state.busy || !state.editor) return;
    state.busy = true;
    setDisabled(true);
    try {
      const captured = state.kind === "quote" ? await capturedEstimates() : {};
      await persist(captured);
      message("Document saved. Save the project to keep its portable copy.");
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
      setDisabled(false);
    }
  }
  async function downloadEditor() {
    if (state.busy || !state.editor) return;
    state.busy = true;
    setDisabled(true);
    try {
      if (!state.editor.pendingIssue) {
        const captured = state.kind === "quote" ? await capturedEstimates() : {},
          saved = await persist(captured);
        state.editor.pendingIssue = {
          workspace_id: state.workspace,
          id: saved.id,
          kind: saved.kind,
          version: saved.version,
          request_id: crypto.randomUUID(),
          ...captured
        };
      }
      const result = await window.CeasefireDownloads.save("/api/commercial/issue", state.editor.pendingIssue, {
        button: root().querySelector(".commercial-editor-actions button:last-child")
      });
      if (result?.cancelled) {
        message("Download cancelled.");
        return;
      }
      state.editor.pendingIssue = null;
      changed();
      await load();
      const latest = state.model.documents.find(document => document.id === state.editor.document.id);
      if (latest) adoptSaved(copy(latest));
      else renderBoard();
      message(`PDF saved as ${result?.filename || latest?.last_number || "the numbered document"}.`);
    } catch (error) {
      const text = error.message.includes("document workspace belongs to a different project")
        ? "Save the project, then download this document again. " + error.message
        : error.message;
      message(text, true);
    } finally {
      state.busy = false;
      setDisabled(false);
    }
  }
  async function completeProjectSnapshot() {
    if (state.busy || state.dirty) throw new Error("Save or discard commercial document edits before saving the project.");
    const workspace = currentWorkspace();
    if (!workspace) return null;
    const result = await request(`state?workspace=${encodeURIComponent(workspace)}`);
    return result.snapshot;
  }
  window.CeasefireCommercial = {
    activate,
    async openFromEstimate(kind = "quote") {
      if (!names[kind]) return;
      if (state.busy || state.dirty) return;
      const context = window.CeasefireProject?.runtimeContext?.();
      if (state.kind !== kind || state.model?.workspace_id !== currentWorkspace()) await activate(kind);
      const workspace = currentWorkspace();
      if (context === window.CeasefireProject?.runtimeContext?.() && workspace && state.workspace === workspace && state.kind === kind && state.model?.workspace_id === workspace && !state.busy && !state.dirty) await openNew(true);
    },
    completeProjectSnapshot,
    async prepareProject(value, workspace_id) {
      return {
        value: copy(value || null),
        workspace_id
      };
    },
    applyProject(prepared) {
      state.workspace = prepared?.workspace_id || null;
      state.model = null;
      state.editor = null;
      state.dirty = false;
      state.changed = false;
      state.revision++;
    },
    projectFingerprint() {
      return JSON.stringify({
        workspace: state.workspace,
        documents: state.model?.snapshot,
        editor: state.editor?.document,
        dirty: state.dirty
      });
    },
    hasPendingOperation() {
      return state.busy || state.dirty;
    },
    hasProjectChanges() {
      return state.changed || state.dirty;
    },
    markProjectSaved(saved, captured) {
      if (!captured || JSON.stringify(state.model?.snapshot) === JSON.stringify(captured)) state.changed = false;
    }
  };
  document.addEventListener("click", event => {
    for (const menu of document.querySelectorAll(".commercial-columns-menu[open],.commercial-card-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    for (const menu of document.querySelectorAll(".commercial-columns-menu[open],.commercial-card-menu[open]")) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  const closeCardMenus = () => document.querySelectorAll(".commercial-card-menu[open]").forEach(menu => { menu.open = false; });
  window.addEventListener("resize", closeCardMenus);
  window.addEventListener("resize", () => {
    document.querySelectorAll(".commercial-line-description").forEach(resizeDescription);
  });
  document.addEventListener("scroll", event => {
    if (!event.target.closest?.(".commercial-menu-options")) closeCardMenus();
  }, true);
})();
