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
  function select(options, value, changed) {
    const element = node("select");
    options.forEach(item => {
      const option = node("option", "", item);
      option.value = item;
      element.append(option);
    });
    element.value = value;
    element.addEventListener("change", () => {
      changed(element.value);
      markDirty();
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
    controls.append(field("Search documents", search), button("New " + names[state.kind], () => openNew(), true));
    const columns = node("details", "commercial-columns-menu");
    columns.append(node("summary", "button secondary", "Columns"));
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
      columns.append(label);
    }
    controls.append(columns);
    host.append(controls, node("div", "commercial-board"));
    renderCards();
  }
  function renderCards() {
    const board = root()?.querySelector(".commercial-board");
    if (!board) return;
    board.replaceChildren();
    const documents = state.model.documents.filter(document => document.kind === state.kind && `${document.fields.title} ${document.fields.details.client} ${document.last_number}`.toLowerCase().includes(state.search.toLowerCase()));
    for (const status of state.model.statuses[state.kind]) {
      if (state.hidden.has(status)) continue;
      const column = node("section", "commercial-column");
      column.setAttribute("aria-label", status);
      const matches = documents.filter(document => document.status === status);
      column.append(node("h2", "", `${status} (${matches.length})`));
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
        const card = node("article", "commercial-card");
        card.draggable = true;
        card.addEventListener("dragstart", event => {
          event.dataTransfer.setData("text/plain", document.id);
          event.dataTransfer.effectAllowed = "move";
        });
        card.append(node("h3", "", document.fields.title), node("p", "helper", document.last_number || "Number assigned on PDF download"), node("p", "", document.fields.details.client), node("p", "helper", "Updated " + new Date(document.updated_at).toLocaleString("en-AU")));
        const menu = node("details", "commercial-card-menu");
        menu.append(node("summary", "button secondary", "Actions"), button("Open / Edit", () => {
          if (!state.busy) openEditor(document);
        }), button("Delete", () => remove(document)));
        const statusSelect = select(state.model.statuses[state.kind], document.status, value => void move(document, value));
        statusSelect.addEventListener("change", () => {
          state.dirty = false;
        });
        card.append(menu, field("Status", statusSelect));
        column.append(card);
      }
      board.append(column);
    }
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
  async function openNew() {
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
      if (state.kind === "quote") await refreshEstimates([window.CeasefireEstimates?.activeId?.() || "estimate-1"]);
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
      generatedScope: null
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
    form.append(actions, field("Document title", input(fields.title, value => fields.title = value)), field("Status", select(state.model.statuses[state.kind], state.editor.document.status, value => state.editor.document.status = value)));
    const details = node("section", "card commercial-details");
    details.append(node("h2", "", "Project details"));
    for (const [key, label] of [["project_no", "Project number"], ["client", "Client"], ["site_address", "Site address"], ["contact", "Client contact"], ["phone", "Client phone"], ["email", "Client email"], ["date", "Document date"]]) details.append(field(label, input(fields.details[key], value => fields.details[key] = value, key === "date" ? "date" : "text")));
    form.append(details);
    if (state.kind === "quote") {
      form.append(field("Introduction", textarea(fields.introduction, value => fields.introduction = value)));
      const chooser = node("details", "commercial-estimate-picker");
      chooser.append(node("summary", "button secondary", "Select estimates"), node("div", "commercial-estimate-options"));
      form.append(chooser);
      form.append(node("section", "commercial-lines"), node("section", "commercial-scope"), richEditor("Scope preamble", fields.scope, value => fields.scope = value), richEditor("Allowances", fields.allowances, value => fields.allowances = value), node("div", "commercial-totals"), richEditor("Terms & Conditions", fields.terms, value => fields.terms = value));
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
  }
  function renderOrderFields(form, fields) {
    const commonReview = [["approval", "Approval"], ["reviewed_by", "Reviewed by"], ["review_date", "Review date"]];
    const groups = state.kind === "work_order" ? [["Work order details", [["start_date", "Proposed start date"], ["end_date", "Proposed end date"], ["urgency", "Category / urgency"], ["quote_reference", "Quote reference"], ["description", "Description of works"], ["estimated_cost", "Estimated cost (AUD)"], ["attachments", "Image / video references"]]], ["Work order review", [...commonReview, ["justification", "Justification"]]], ["OHS documentation", [["swms", "SWMS"], ["sds", "SDS"], ["sop", "SOP"], ["other_documents", "Other documents"], ["prepared_by", "Prepared by"]]], ["Client approval", [["client_approval", "Safety documentation approval"], ["client_approved_by", "Approved by"], ["client_approval_date", "Approval date"]]], ["Progress and completion", [["progress", "Work progress"], ["claim", "Products and services charged"], ["certification", "Certification details"], ["completion", "Completion"], ["closed_by", "Closed by"]]]] : [["Purchase order information", [["work_order_reference", "Work order reference"], ["supplier", "Supplier"], ["supplier_email", "Supplier email"], ["supplier_contact", "Supplier contact"], ["payment_terms", "Payment terms"], ["ship_to_name", "Ship to name"], ["ship_to_address", "Ship to address"], ["delivery_date", "Delivery date"], ["expense_type", "Type of expense"], ["delivery_method", "Delivery or pickup"]]], ["Request and approval", [["requested_by", "Requested by"], ["requested_date", "Request date"], ...commonReview]], ["Procurement verification", [["verification", "Verification method, specification, result and actions"], ["sent_by", "Sent by"], ["sent_date", "Sent date"], ["verified_by", "Verified by"], ["verified_date", "Verification date"]]]];
    for (const [title, items] of groups) {
      const section = node("section", "card commercial-order-fields");
      section.append(node("h2", "", title));
      for (const [key, label] of items) section.append(field(label, textarea(fields.order[key], value => fields.order[key] = value)));
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
  async function capturedEstimates() {
    if (!window.CeasefireEstimates?.capture) throw new Error("The project estimate workspace is unavailable.");
    return window.CeasefireEstimates.capture();
  }
  async function refreshEstimates(selectedIds) {
    const editor = state.editor;
    if (!editor) return;
    state.busy = true;
    setDisabled(true);
    message("Updating linked estimates…");
    try {
      const captured = await capturedEstimates();
      const derived = await request("derive", {
        workspace_id: state.workspace,
        ...captured,
        selected_ids: selectedIds
      });
      if (editor !== state.editor) return;
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
    } catch (error) {
      message(error.message, true);
      renderEstimateOptions();
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
      description.append(textarea(line.description, value => line.description = value));
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
    for (const scope of state.editor.document.fields.scope_tables) {
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
    Object.assign(fields, saved.fields);
    Object.assign(state.editor.document, saved, {
      fields
    });
    renderLines();
    renderScope();
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
    async openFromEstimate() {
      if (state.busy || state.dirty) return;
      const context = window.CeasefireProject?.runtimeContext?.();
      if (state.kind !== "quote" || state.model?.workspace_id !== currentWorkspace()) await activate("quote");
      const workspace = currentWorkspace();
      if (context === window.CeasefireProject?.runtimeContext?.() && workspace && state.workspace === workspace && state.kind === "quote" && state.model?.workspace_id === workspace && !state.busy && !state.dirty) await openNew();
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
})();
