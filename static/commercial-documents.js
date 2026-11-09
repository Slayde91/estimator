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
    savedCards: [],
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
  const trackingMoney = new Intl.NumberFormat('en-AU', {style:'currency',currency:'AUD'});
  const rateKeys = ["ordinary_time", "time_and_half", "double_time", "site_remobilisation", "access_equipment_transport", "equipment", "materials"];
  const rateDefaults = {version:null, rates:null, pending:new Map(), saving:null, loading:null, timer:null, error:null, remembered:false};
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
  function pdfDownloadButton(action) {
    const control = button("", action, true);
    control.classList.add("icon-only", "commercial-download-pdf");
    for (const attribute of ["title", "aria-label"]) {
      control.setAttribute(attribute, "Download PDF");
      window.CeasefireI18n?.attr(control, attribute, "Download PDF");
    }
    const icon = node("span", "download-format-icon"); icon.setAttribute("aria-hidden", "true");
    icon.append(node("span", "download-arrow", "⇩"), node("span", "download-format", "PDF"));
    control.append(icon); return control;
  }
  function documentTitle(document) {
    if (document.kind !== "work_order") return document.fields.title;
    const number = document.reference || document.fields.order.work_order_reference || document.last_number;
    return number ? `${number}: ${document.fields.details.client || "—"}` : names.work_order;
  }
  function field(label, control) {
    const wrapper = node("label", "field");
    control.setAttribute("aria-label", label);
    wrapper.append(node("span", "", label), control);
    return wrapper;
  }
  function backButton(label, action) {
    const control = button("", action);
    control.classList.add("icon-only");
    control.title = label;
    control.setAttribute("aria-label", label);
    window.CeasefireI18n?.attr(control, "title", label);
    window.CeasefireI18n?.attr(control, "aria-label", label);
    const icon = node("span", "button-symbol", "←");
    icon.setAttribute("aria-hidden", "true");
    control.append(icon);
    return control;
  }
  function addButton(label, action) {
    const control = button("", action, true);
    control.classList.add("icon-only", "penetration-new-item-action");
    control.title = label; control.setAttribute("aria-label", label);
    window.CeasefireI18n?.attr(control, "title", label); window.CeasefireI18n?.attr(control, "aria-label", label);
    const symbol = node("span", "button-symbol", "+"); symbol.setAttribute("aria-hidden", "true");
    control.append(symbol); return control;
  }
  function requireProject(source = null) {
    if (source?.createdProject === true) return true;
    if (source) { message("Create or load a project before creating documents.", true); return false; }
    if (window.CeasefireProject?.requireCreatedProject) return window.CeasefireProject.requireCreatedProject();
    message("Create or load a project before creating documents.", true); return false;
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
    if (state.editor) {state.editor.pendingIssue = null;state.editor.pendingProjectDetails = null;}
    window.CeasefireProject?.changed?.();
    if(state.editor) updateRequiredFields();
  }
  function readinessSpecs(action) {
    const document=state.editor?.document;
    return document ? state.model?.requirements?.[action]?.[document.kind]?.[document.status] || [] : [];
  }
  function requirementControl(path) {
    const [group,key,rate]=path.split('.'),host=root();
    if(group==='details')return host?.querySelector(`[data-project-detail="${key}"]`);
    if(group==='order')return host?.querySelector(`[data-order-field="${key}"],[data-order-link="${key}"]`);
    if(group==='signatures')return host?.querySelector(`[data-signature-field="${key}"]`);
    if(group==='work_tracking')return host?.querySelector(`[data-tracking-field="${key}"]`);
    if(group==='rate_schedule')return rate ? host?.querySelector(`[data-rate-key="${rate}"]`) : host?.querySelector('.commercial-rate-schedule textarea');
    return host?.querySelector(`[data-required-path="${path}"]`);
  }
  function requirementPresent(spec) {
    const fields=state.editor.document.fields;
    if(spec.type==='completed' || spec.type==='claimed') {
      const key=spec.type==='completed'?'completed_percent':'claimed_percent';
      return (fields.work_tracking?.rows || []).some(row=>Number(row[key])>0 && Number(row[key])<=100);
    }
    let value=spec.path.split('.').reduce((object,key)=>object?.[key],fields);
    if(spec.type==='signature')return Boolean(value?.strokes?.some(stroke=>stroke.some(point=>point[0]!==stroke[0][0] || point[1]!==stroke[0][1])));
    if(spec.type==='rich') {const parsed=document.createElement('div');parsed.innerHTML=value || '';value=parsed.textContent;}
    const present=typeof value==='string' && value.replace(/\p{Cf}/gu,'').trim().length>0;
    return present && (spec.type!=='number' || (Number.isFinite(Number(value)) && Number(value)>=0));
  }
  function updateRequiredFields() {
    const specs=readinessSpecs('issue'),host=root();
    if(!host)return;
    host.querySelectorAll('.commercial-required-label').forEach(label=>label.classList.remove('commercial-required-label'));
    const required=new Set(specs.map(spec=>requirementControl(spec.path)));
    host.querySelectorAll('[data-commercial-required]').forEach(control=>{control.removeAttribute('aria-required');control.removeAttribute('data-commercial-required');if('required' in control)control.required=false;if(!required.has(control)){control.removeAttribute('aria-invalid');control.classList.remove('commercial-requirement-invalid');}});
    for(const spec of specs) {
      const control=requirementControl(spec.path);if(!control)continue;
      control.setAttribute('data-commercial-required','true');
      if(control.matches('input,textarea,select,[role=textbox]'))control.setAttribute('aria-required','true');
      if('required' in control)control.required=true;
      if(requirementPresent(spec)) {control.removeAttribute('aria-invalid');control.classList.remove('commercial-requirement-invalid');}
      const label=control.closest('.field')?.querySelector(':scope > span') || control.closest('details.commercial-rich')?.querySelector('summary');
      label?.classList.add('commercial-required-label');
    }
  }
  function validateReadiness(action) {
    const missing=readinessSpecs(action).filter(spec=>!requirementPresent(spec));
    if(!missing.length)return;
    for(const spec of missing) {
      const control=requirementControl(spec.path);if(!control)continue;
      control.setAttribute('aria-invalid','true');control.classList.add('commercial-requirement-invalid');
      const details=control.closest('details');if(details)details.open=true;
    }
    const first=requirementControl(missing[0].path),focus=first?.matches('input,textarea,select,[contenteditable=true]')?first:first?.querySelector('button,input,textarea,select');
    focus?.focus();
    const args=[window.CeasefireI18n?.translate(names[state.kind]) || names[state.kind],missing.map(spec=>window.CeasefireI18n?.translate(spec.label) || spec.label).join(', ')];
    const source='Complete required {0} fields: {1}.';
    throw new Error(window.CeasefireI18n?.translate(source,args) || source.replace(/\{(\d+)\}/g,(_,index)=>args[index]));
  }
  function positionCardMenu(menu) {
    if (!menu.open) return;
    const panel = menu.querySelector(".commercial-menu-options");
    const rect = menu.querySelector("summary").getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) { menu.open=false; return; }
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, rect.right - panel.offsetWidth))}px`;
    panel.style.top = `${rect.bottom + panel.offsetHeight + 12 <= innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - panel.offsetHeight - 6)}px`;
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
    if (!response.ok) {
      const error = new Error(result.error || "The commercial document request failed.");
      error.status = response.status; throw error;
    }
    return result;
  }
  function acceptRateDefaults(value) {
    if (!value || !Number.isInteger(value.version) || value.version < 1 || !value.rates ||
        rateKeys.some(key => typeof value.rates[key] !== "string")) throw new Error("Rate defaults could not be confirmed.");
    if (rateDefaults.version !== null && value.version < rateDefaults.version) throw new Error("Rate defaults changed while loading. Retry your changes.");
    rateDefaults.version = value.version; rateDefaults.rates = {...value.rates};
  }
  function rateDefaultsNotice() {
    for (const status of document.querySelectorAll(".commercial-rate-defaults-status")) {
      const invalid = status.closest(".commercial-rate-schedule")?.querySelector('[data-rate-invalid="true"]');
      const failed = Boolean(rateDefaults.error && rateDefaults.pending.size);
      const source = invalid ? "Enter a rate between zero and one billion with at most six decimal places."
        : failed ? (rateDefaults.error.status === 409
          ? "Rate defaults changed in another window. Retry to use your entered rates for new documents."
          : "Rate defaults could not be saved. Your values are kept; retry to remember them.")
        : rateDefaults.pending.size || rateDefaults.saving ? "Remembering rates…"
        : rateDefaults.remembered ? "Rates remembered for new documents." : "Rate changes are remembered for new documents.";
      status.classList.toggle("error", Boolean(invalid || failed));
      if (window.CeasefireI18n) window.CeasefireI18n.text(status, source); else status.textContent = source;
      const retry = status.parentElement.querySelector(".commercial-rate-defaults-retry");
      if (retry) { retry.hidden = !failed; retry.disabled = Boolean(rateDefaults.saving || rateDefaults.loading); }
    }
  }
  async function loadRateDefaults(force = false) {
    if (rateDefaults.loading) await rateDefaults.loading;
    if (!force && rateDefaults.version !== null) return;
    rateDefaults.loading = request("rate-defaults").then(acceptRateDefaults);
    try { await rateDefaults.loading; } finally { rateDefaults.loading = null; rateDefaultsNotice(); }
  }
  async function flushRateDefaults({retry = false} = {}) {
    if (rateDefaults.timer) { clearTimeout(rateDefaults.timer); rateDefaults.timer = null; }
    if (rateDefaults.saving) { await rateDefaults.saving; return flushRateDefaults({retry}); }
    if (!rateDefaults.pending.size) return;
    if (rateDefaults.error && !retry) throw rateDefaults.error;
    rateDefaults.saving = (async () => {
      try {
        await loadRateDefaults(retry);
        const changes = Object.fromEntries(rateDefaults.pending);
        if (!Object.keys(changes).length) return;
        const saved = await request("rate-defaults", {expected_version:rateDefaults.version, rates:changes});
        acceptRateDefaults(saved); rateDefaults.error = null;
        for (const [key, value] of Object.entries(changes)) if (rateDefaults.pending.get(key) === value) rateDefaults.pending.delete(key);
        rateDefaults.remembered = !rateDefaults.pending.size;
      } catch (error) { rateDefaults.error = error; throw error; }
      finally { rateDefaults.saving = null; rateDefaultsNotice(); }
    })();
    rateDefaultsNotice();
    await rateDefaults.saving;
    if (rateDefaults.pending.size) await flushRateDefaults();
  }
  function rememberRate(key, value, control) {
    // Incomplete document rates do not replace valid remembered defaults.
    if(value.trim()==='') {control.dataset.rateInvalid='false';rateDefaults.pending.delete(key);rateDefaultsNotice();return;}
    const match = value.trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i), number = Number(value);
    const exponent = match ? Number(match[4] || 0) - (match[3] || "").length : -Infinity;
    const valid = value.trim() !== "" && match && (match[2] || match[3]) && Number.isFinite(number) && number >= 0 && number <= 1e9 && exponent >= -6 && exponent <= 9;
    control.dataset.rateInvalid = String(!valid);
    if (!valid) { rateDefaults.pending.delete(key); rateDefaultsNotice(); return; }
    rateDefaults.pending.set(key, value); rateDefaults.remembered = false;
    if (rateDefaults.timer) clearTimeout(rateDefaults.timer);
    rateDefaults.timer = setTimeout(() => { rateDefaults.timer = null; void flushRateDefaults().catch(() => {}); }, 300);
    rateDefaultsNotice();
  }
  const linkedIds = lines => lines.map(line => line.estimate_id).filter(Boolean);
  const sourceFor = card => card.source_file ? {file_id: card.source_file, revision: card.source_revision} : null;
  const cardKey = card => [card.source_file || "", card.id].join("/");
  async function documentRequest(action, body, source) {
    if (!source) return request(action, body);
    const {workspace_id, estimates, active_estimate_id, ...fields} = body;
    if (source.file_id.startsWith("local-") && source.documentId) fields.context_id = source.documentId;
    const response = await request("saved-" + action, {...fields, source: {file_id: source.file_id, revision: source.revision}});
    if (!["derive", "defaults", "purchase-order-defaults"].includes(action)) source.revision = response.revision;
    return response.result;
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
    window.CeasefireProject?.refreshPages?.();
    return host;
  }
  async function load(revision = ++state.revision, refresh = false) {
    const workspace = state.workspace;
    const context = window.CeasefireProject?.runtimeContext?.();
    const result = await request(`state?workspace=${encodeURIComponent(workspace)}`);
    if (state.kind === "purchase_order") result.products = (await request(`supplier-products?workspace=${encodeURIComponent(workspace)}`)).products;
    if (revision !== state.revision || workspace !== state.workspace || workspace !== currentWorkspace() || context !== window.CeasefireProject?.runtimeContext?.()) return false;
    {
      let register;
      do {
        register = await request(`register?workspace=${encodeURIComponent(workspace)}${refresh ? "&refresh=1" : ""}`);
        refresh = false;
        if (revision !== state.revision || workspace !== currentWorkspace() || context !== window.CeasefireProject?.runtimeContext?.()) return false;
      } while (register.scan_pending);
      const active = window.CeasefireProject?.context?.();
      const diskRevision = register.revisions?.[active?.project_path];
      result.activeFileChanged = Boolean(diskRevision && active?.project_revision && diskRevision !== active.project_revision);
      state.savedCards = register.documents.filter(card => card.source_path
        ? card.source_path !== active?.project_path || result.activeFileChanged
        : !card.current_workspace);
      result.unavailableProjects = register.error_count;
      result.unavailableSources = register.unavailable_sources || [];
    }
    state.model = result;
    return true;
  }
  let leavingEditor = false;
  async function leaveEditor() {
    if (state.busy || leavingEditor) return false;
    const editor = state.editor;
    leavingEditor = true;
    try {
      if (state.dirty) {
        const label = names[state.kind].toLowerCase();
        const discard = await window.CeasefireDialogs.confirm(`Discard the current ${label}?`, "", "Yes", "Cancel");
        if (editor !== state.editor || state.busy) return false;
        if (!discard) {
          window.CeasefireDialogs.message("Save or discard the current commercial document edit before changing views.", true);
          return false;
        }
      }
      if (rateDefaults.pending.size || rateDefaults.saving) {
        state.busy = true; setDisabled(true);
        try { await flushRateDefaults(); }
        catch (error) { message(error.message, true); return false; }
        finally { state.busy = false; setDisabled(false); }
      }
      if(state.dirty)discardProjectDetailEdits(editor);
      renderBoard();
      window.CeasefireProject?.changed?.();
      return true;
    } finally {
      leavingEditor = false;
    }
  }
  async function activate(kind) {
    if (!names[kind]) return;
    if (state.busy || (state.dirty && !await leaveEditor())) return;
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
      if (await load(revision,true)) renderBoard();
    } catch (error) {
      if (revision === state.revision && context === window.CeasefireProject?.runtimeContext?.()) message(error.message, true);
    }
  }
  function renderBoard() {
    clearPricingPickers();
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
    if (state.model.unavailableSources?.length) {
      const notice = node("section","commercial-source-notice");
      notice.append(node("h2","","Unavailable project files"));
      const missing = node("ul");
      for (const source of state.model.unavailableSources) {
        const description = source.path
          ? `${source.title} — the saved file could not be read at ${source.path}`
          : `${source.title} — CLASSIFIRE has issued document history for this project but has no current saved file for it.`;
        const item = node("li", "", description);
        if (source.id) {
          const ignore = button("Ignore deleted project", async () => {
          if (state.busy) return;
          const accepted = await window.CeasefireDialogs.confirm("Ignore project source", "Stop looking for this project's saved file and hide its unavailable-file notice? Issued document history is retained.", "Yes", "Cancel");
          if (!accepted) return;
          state.busy = true;
          try {
            await request("ignore-source", {workspace_id: state.workspace, id: source.id});
            if (await load()) {
              renderBoard(); message("Project source ignored.");
              const notice = root().querySelector(".commercial-message");
              if (notice?.firstChild) window.CeasefireI18n?.text(notice.firstChild, "Project source ignored.");
              const undo = button("Undo", async () => {
                try {
                  await request("restore-source", {workspace_id: state.workspace, id: source.id});
                  if (await load()) renderBoard();
                } catch (error) { message(error.message, true); }
              });
              undo.setAttribute("data-i18n", "Undo");
              notice?.append(undo);
            }
          } catch (error) { message(error.message, true); }
          finally { state.busy = false; }
          });
          ignore.setAttribute("data-i18n", "Ignore deleted project");
          item.append(ignore);
        }
        missing.append(item);
      }
      notice.append(missing,node("p","","To show its current documents, use Projects → Load to open the project's .cf.json file, or link the folder containing it."));
      list.insertBefore(notice,list.querySelector(".commercial-board"));
    }
    host.append(list);
    renderCards();
    window.CeasefireProject?.refreshPages?.();
    if (state.model.unavailableProjects) message("Some linked project files could not be read. See Projects for details.", true);
  }
  function projectDetailsSnapshot(source = null) {
    return copy(source ? source.projectDetails || {} : window.CeasefireProject?.details?.() || {});
  }
  function commercialProjectDetails(source = null) {
    const details = projectDetailsSnapshot(source);
    return {project_no:details.project_no || "", client:details.client || "", site_address:details.site_address || "",
      contact:details.contact_name || "", phone:details.contact_phone || "", email:details.contact_email || ""};
  }
  const projectDetailKeys={client:'client',contact:'contact_name',phone:'contact_phone',email:'contact_email',site_address:'site_address',
    account_id:'account_id',contact_id:'contact_id',billing_address:'billing_address',abn_acn:'abn_acn'};
  function applyProjectDetails(fields, details) {
    // Legacy document-only overrides remain readable in saved snapshots. The
    // editable document now follows its Project; issued PDF bytes stay intact.
    Object.assign(fields.details,details);
    delete fields.detail_overrides;
  }
  function refreshEditorProjectDetails() {
    const editor=state.editor;if(!editor)return;
    const lockedNumber=boundWorkOrderProjectNumber(editor);
    applyProjectDetails(editor.document.fields,commercialProjectDetails(editor.source));
    if(lockedNumber)editor.document.fields.details.project_no=lockedNumber;
    root()?.querySelectorAll('[data-project-detail]').forEach(control=>control.value=editor.document.fields.details[control.dataset.projectDetail] || '');
    editor.panels?.refreshProjectDetails(projectDetailsSnapshot(editor.source));
  }
  function editDocumentDetails(fields, values) {
    const editor=state.editor,previous=projectDetailsSnapshot(editor.source),patch={};
    for(const [key,value] of Object.entries(values))if(projectDetailKeys[key])patch[projectDetailKeys[key]]=String(value ?? '').trim();
    if(editor.source && !editor.source.file_id.startsWith('local-')) {
      editor.source.projectDetails={...previous,...patch};
      editor.source.projectUpdates={...editor.source.projectUpdates,...patch};
    } else if(!editor.source) {
      editor.projectBaseline ||= window.CeasefireProject.captureCommercialDetailsEdit();
      editor.projectOriginal ||= {};
      editor.projectApplied ||= {};
      for(const key of Object.keys(patch))if(!Object.hasOwn(editor.projectOriginal,key))editor.projectOriginal[key]=previous[key] || '';
      window.CeasefireProject.applyCommercialDetails(patch,editor.projectContext);
      Object.assign(editor.projectApplied,patch);
    } else {
      // Historical unfiled records have no Project to edit.
      for(const [key,value] of Object.entries(values))if(Object.hasOwn(fields.details,key))fields.details[key]=String(value ?? '').trim();
      markDirty();return;
    }
    refreshEditorProjectDetails();markDirty();
  }
  function discardProjectDetailEdits(editor) {
    if(editor?.source || !editor?.projectOriginal)return;
    const current=projectDetailsSnapshot(),patch={};
    for(const [key,value] of Object.entries(editor.projectOriginal))if(current[key]===editor.projectApplied[key])patch[key]=value;
    if(Object.keys(patch).length)window.CeasefireProject.applyCommercialDetails(patch,editor.projectContext,editor.projectBaseline);
  }
  function boundWorkOrderProjectNumber(editor) {
    const doc=editor.document;
    if(doc.kind!=='work_order')return '';
    const related=editor.source?.related || state.model.documents;
    const stored=related.find(item=>item.id===doc.id && item.kind==='work_order');
    if(stored && (stored.fields.order.work_order_reference || stored.fields.order.quote_id))return stored.fields.details.project_no;
    const quote=related.find(item=>item.id===doc.fields.order.quote_id && item.kind==='quote');
    return quote?.fields.details.project_no || (doc.fields.order.work_order_reference ? doc.fields.details.project_no : '');
  }
  function renderCards() {
    const board = root()?.querySelector(".commercial-board");
    if (!board) return;
    board.replaceChildren();
    let all = state.model.documents.filter(document => document.kind === state.kind);
    {
      const details = commercialProjectDetails();
      const local = state.model.activeFileChanged ? [] : all.map(card => ({
        ...card, fields: {...card.fields, details: {...card.fields.details, ...details}}
      }));
      all = local.concat(state.savedCards.filter(card => card.kind === state.kind));
    }
    const cardInfo = doc => {
      const fields = doc.fields, details = fields.details, order = fields.order;
      const po = doc.kind === "purchase_order", wo = doc.kind === "work_order";
      const number = doc.reference || (wo && order.work_order_reference) || doc.last_number;
      const cost = wo ? order.estimated_cost || doc.grand_total || state.model.quote_totals?.[order.quote_id]?.[order.quote_reference] || "" : doc.grand_total;
      const grand = cost === undefined ? summary(fields).money(summary(fields).total)
        : cost && Number.isFinite(Number(cost)) ? new Intl.NumberFormat("en-AU", {style:"currency",currency:"AUD"}).format(Number(cost)) : cost;
      return [
        [po ? "Supplier" : "Client", po ? order.supplier : details.client],
        ["Contact", po ? order.supplier_contact : details.contact],
        ["Address", details.site_address],
        [po ? "PO No." : wo ? "WO No." : "Quote No.", number], ["Total", grand],
        ["Updated", new Intl.DateTimeFormat("en-AU", {year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false}).format(new Date(doc.updated_at))]
      ];
    };
    const documents = all.filter(doc => [documentTitle(doc), doc.fields.title, doc.fields.details.project_no, ...cardInfo(doc).map(pair=>pair[1])].join(" ").toLowerCase().includes(state.search.toLowerCase()));
    documents.sort((a, b) => state.sort === "Document name A–Z"
      ? documentTitle(a).localeCompare(documentTitle(b), "en", {numeric:true}) || a.id.localeCompare(b.id)
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
        const document = documents.find(item => cardKey(item) === identity);
        if (document) void move(document, status);
      });
      for (const document of matches) {
        const card = node("article", "commercial-card project-kanban-card");
        card.draggable = true;
        card.addEventListener("dragstart", event => {
          if (state.busy || event.target.closest("button,select,summary,input")) { event.preventDefault(); return; }
          event.dataTransfer.setData("text/plain", cardKey(document));
          event.dataTransfer.effectAllowed = "move";
        });
        const menu = node("details", "commercial-card-menu");
        const toggle = node("summary", "", "▾");
        toggle.setAttribute("aria-label", `Actions for ${documentTitle(document)}`);
        const actions = node("div", "commercial-menu-options");
        const options = [["Open", () => openCard(document)], ["Edit", () => openCard(document)], ["Delete", () => remove(document)]];
        if (state.kind === "quote") options.splice(2, 0, ["Create WO", () => openCard(document, true)]);
        for (const [label, action] of options) {
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
        menu.addEventListener("toggle", () => positionCardMenu(menu));
        const title = button(documentTitle(document), () => { if (!state.busy) void openCard(document); });
        title.className = "project-title-button";
        const heading = node("div", "project-card-heading");
        heading.append(title, menu);
        const information = node("dl", "commercial-card-info");
        for (const [label, value] of cardInfo(document)) {
          const heading = node("dt", "", label);
          window.CeasefireI18n?.text(heading, label);
          information.append(heading, node("dd", "", value || "—"));
        }
        card.append(heading, information);
        column.append(card);
      }
      if (!matches.length) column.append(node("p", "project-column-empty", "No documents"));
      board.append(column);
    }
    if (!board.children.length) board.append(node("p", "empty-state", "Choose a column from Columns to show documents."));
  }
  async function openCard(card, createWorkOrder = false) {
    if (state.busy) return;
    const source = sourceFor(card);
    const revision = state.revision;
    const workspace=state.workspace,context=window.CeasefireProject?.runtimeContext?.();
    try {
      let document = card;
      if (source) {
        state.busy = true;
        const opened = await request("saved-open", {source, id: card.id});
        if (state.revision !== revision || workspace!==state.workspace || workspace!==currentWorkspace() || context!==window.CeasefireProject?.runtimeContext?.()) return;
        document = opened.document;
        source.documentId = document.id;
        source.estimates = opened.estimates;
        source.quoteTotals = opened.quote_totals;
        source.quoteRows = opened.quote_rows;
        source.related = opened.related;
        source.projectDetails = opened.project_details || {
          project_no:document.fields.details.project_no,client:document.fields.details.client,site_address:document.fields.details.site_address,
          contact_name:document.fields.details.contact,contact_phone:document.fields.details.phone,contact_email:document.fields.details.email
        };
        source.createdProject = opened.created_project === true;
        state.busy = false;
      }
      if (!createWorkOrder) { openEditor(document, source); return; }
      if (!requireProject(source)) return;
      if (!document.last_number) {
        message("Download the Quote PDF to assign its number before creating a Work Order.", true);
        return;
      }
      const details = {...document.fields.details, date: today()};
      const {fields} = await documentRequest("defaults", {workspace_id: state.workspace, kind: "work_order", details}, source);
      if (state.revision !== revision || !await window.CeasefireProject.openCommercial("work_order")) return;
      fields.order.quote_id = document.id;
      fields.order.quote_reference = document.last_number;
      fields.order.description = document.fields.lines.map(line => line.description).join("\n");
      openEditor({id: crypto.randomUUID(), version: 0, kind: "work_order", status: "Draft", fields, last_number: ""}, source, document);
      markDirty();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  async function saveActiveProject() {
    const target = window.CeasefireProject?.context?.();
    if (!target?.project_token) return false;
    state.syncingProject = true;
    try {
      const result = await window.CeasefireProject.saveAfterDownload(target);
      if (!result?.saved) throw new Error(result?.error || "The project file save could not be confirmed.");
      return true;
    } finally {
      state.syncingProject = false;
    }
  }
  async function move(document, status) {
    if (state.busy) return;
    state.busy = true;
    try {
      await documentRequest("status", {
        workspace_id: state.workspace,
        id: document.id,
        version: document.version,
        status
      }, sourceFor(document));
      if (!document.source_file) changed();
      await load();
      if (!document.source_file) await saveActiveProject();
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
      await documentRequest("delete", {
        workspace_id: state.workspace,
        id: document.id,
        version: document.version
      }, sourceFor(document));
      if (!document.source_file) changed();
      await load();
      if (!document.source_file) await saveActiveProject();
      renderBoard();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
    }
  }
  async function openNew(fromEstimate = false) {
    if (state.busy || !requireProject()) return;
    const revision=state.revision,workspace=state.workspace,kind=state.kind,context=window.CeasefireProject?.runtimeContext?.(),
      projectDetails=projectDetailsSnapshot(),projectFingerprint=JSON.stringify(projectDetails);
    const current=()=>revision===state.revision && workspace===state.workspace && workspace===currentWorkspace() && kind===state.kind
      && context===window.CeasefireProject?.runtimeContext?.() && projectFingerprint===JSON.stringify(projectDetailsSnapshot());
    state.busy = true;
    try {
      await flushRateDefaults();
      if(!current())return;
      const details = {
        ...commercialProjectDetails(),
        date: today()
      };
      const result = await request("defaults", {
        workspace_id: state.workspace,
        kind: state.kind,
        details,
        project_details:projectDetails
      });
      if(!current())return;
      if (result.rate_defaults) acceptRateDefaults(result.rate_defaults);
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
          if (eligible.length === 1) fields.order.quote_reference = eligible[0].last_number;
          fields.order.description = fields.lines.map(line => line.description).join("\n");
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
  function richEditor(label, value, changedValue, trackDirty = markDirty, collapsed = false) {
    const section = node(collapsed ? "details" : "section", "commercial-rich"),
      toolbar = node("div", "commercial-rich-toolbar"),
      editor = node("div", "commercial-rich-input");
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-label", label);
    if(label==='Allowances')editor.dataset.requiredPath='allowances';
    if(label==='Terms & Conditions')editor.dataset.requiredPath='terms';
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
        trackDirty();
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
      trackDirty();
    });
    editor.addEventListener("paste", event => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    section.append(node(collapsed ? "summary" : "h2", "", label), toolbar, editor);
    return section;
  }
  function displayTerms(value) {
    const parsed = document.createElement("div"); parsed.innerHTML = value;
    const canonical = /^These terms and conditions are between .+, \(we, us or our\) and you, the person or entity stated in the Quote \(you or your\), together the Parties and each a Party\. Together, these terms and conditions and the Quote \(attached to these Terms or the Quote\) form the entire agreement under which we will provide the Goods and Services to you \(Terms\)\.$/;
    for (const block of parsed.querySelectorAll("p,div,li")) {
      if (!canonical.test(block.textContent.replace(/\s+/g, " ").trim()) || block.querySelector("p,div,li")) continue;
      if (block.children.length === 1 && ["B", "STRONG"].includes(block.firstElementChild.tagName) && block.textContent === block.firstElementChild.textContent) continue;
      const bold = document.createElement("b");
      while (block.firstChild) bold.append(block.firstChild);
      block.append(bold);
    }
    return parsed.innerHTML;
  }
  async function createPurchaseOrder() {
    if (state.busy || state.kind !== "work_order") return;
    const editor = state.editor;
    if (!requireProject(editor?.source)) return;
    if (!editor || state.dirty || !editor.document.version || !editor.document.fields.order.work_order_reference) {
      message("Save this Work Order before creating a Purchase Order.", true); return;
    }
    const workspace = state.workspace, context = window.CeasefireProject?.runtimeContext?.();
    const current = () => state.editor === editor && state.workspace === workspace && workspace === currentWorkspace()
      && context === window.CeasefireProject?.runtimeContext?.();
    state.busy = true; setDisabled(true);
    try {
      const result = await documentRequest("purchase-order-defaults", {workspace_id: workspace,
        work_order_id: editor.document.id, work_order_version: editor.document.version}, editor.source);
      if (!current()) return;
      state.busy = false; setDisabled(false);
      if (!await window.CeasefireProject.openCommercial("purchase_order")) return;
      if (context !== window.CeasefireProject?.runtimeContext?.() || workspace !== state.workspace || state.kind !== "purchase_order") return;
      result.fields.details.date = today();
      // A new PO starts at its linked Project's current site; later edits belong to the PO.
      result.fields.order.ship_to_address = commercialProjectDetails(editor.source).site_address || "";
      openEditor({id: crypto.randomUUID(), version: 0, kind: "purchase_order", status: "Draft", fields: result.fields, last_number: ""}, editor.source);
      markDirty();
      if (result.fields.lines.length) message("Enter supplier prices before issuing this Purchase Order.");
    } catch (error) { if (current()) message(error.message, true); }
    finally { if (state.editor === editor) { state.busy = false; setDisabled(false); } }
  }
  function openEditor(document, source = null, linkedQuote = null) {
    if (state.dirty) return;
    clearPricingPickers();
    state.editor = {
      document: copy(document),
      projectContext:window.CeasefireProject?.runtimeContext?.(),
      source,
      linkedQuote,
      pendingIssue: null,
      pendingProjectDetails: null,
      generatedScope: null,
      scopeTables: copy(document.fields.scope_tables || []),
      scopeRevision: 0,
      derivedEstimates: new Map()
    };
    state.dirty = false;
    const host = shell(names[state.kind]),
      form = node("div", "commercial-editor"),
      fields = state.editor.document.fields;
    const lockedNumber=boundWorkOrderProjectNumber(state.editor);
    if (!source || !source.file_id.startsWith('local-')) {
      applyProjectDetails(fields, commercialProjectDetails(source));
    }
    if (lockedNumber) fields.details.project_no = lockedNumber;
    const actions = node("div", "commercial-editor-actions");
    actions.append(backButton("Back to " + names[state.kind] + "s", () => void leaveEditor()), button("Save", () => void saveEditor(), true), pdfDownloadButton(() => void downloadEditor()));
    if (state.kind === "work_order") actions.append(button("Create PO", () => void createPurchaseOrder()));
    const titleRow = node("div", "commercial-title-row");
    const statusControl=select(state.model.statuses[state.kind], state.editor.document.status, value => {
      state.editor.document.status=value;statusControl.dataset.status=value;
    });
    statusControl.classList.add('commercial-document-status');statusControl.dataset.status=state.editor.document.status;
    for(const option of statusControl.options)option.dataset.status=option.value;
    form.append(actions);
    if (state.kind === "work_order") {
      const statusField = field("Status", statusControl); statusField.classList.add("commercial-action-status"); actions.append(statusField);
    } else {
      titleRow.append(field("Document title", input(fields.title, value => fields.title = value)), field("Status", statusControl));
      form.append(titleRow);
    }
    const details = node("section", "card commercial-details");
    details.append(node("h2", "", "Project details"));
    const detailField = (key, label) => {
      const control = key === 'site_address' ? textarea(fields.details[key],value=>fields.details[key]=value)
        : input(fields.details[key], value => fields.details[key] = value, key === "date" ? "date" : "text");
      if(key==='site_address'){control.rows=1;control.classList.add('commercial-project-address');}
      control.dataset.projectDetail=key;
      if (key !== "date") control.readOnly = true;
      return field(label, control);
    };
    const detailPair = pairs => {
      const pair = node("div", "commercial-field-pair");
      pairs.forEach(([key,label]) => pair.append(detailField(key,label)));
      return pair;
    };
    details.append(detailPair([["date", "Document date"], ["project_no", "Project number"]]));
    if (state.kind !== "purchase_order") details.append(detailPair([["client", "Client"], ["contact", "Client contact"]]));
    if (state.kind !== "purchase_order") {
      details.append(detailField("site_address", "Site address"));
      details.append(detailPair([["phone", "Client phone"], ["email", "Client email"]]));
    }
    form.append(details);
    if (state.kind === "quote") {
      form.append(field("Introduction", textarea(fields.introduction, value => fields.introduction = value)));
      const estimateControls = node("div", "commercial-estimate-controls");
      const chooser = node("details", "commercial-estimate-picker");
      chooser.append(node("summary", "button secondary", "Select estimates"), node("div", "commercial-estimate-options"));
      const addCustomRow = addButton("Add custom row", () => {
        fields.lines.push({estimate_id: "", description: "", quantity: "1", unit_price: "0", size: "", comments: ""});
        markDirty();
        renderLines();
        form.querySelector(".commercial-lines tbody tr:last-child textarea")?.focus();
      });
      addCustomRow.classList.add("commercial-add-custom-row");
      estimateControls.append(addCustomRow, chooser);
      form.append(estimateControls);
      form.append(node("section", "commercial-lines"), node("div", "commercial-totals"), rateSchedule(fields), node("section", "commercial-scope"), richEditor("Allowances", fields.allowances, value => fields.allowances = value, markDirty, true), richEditor("Terms & Conditions", displayTerms(fields.terms), value => fields.terms = value, markDirty, true));
    } else {
      renderOrderFields(form, fields);
    }
    host.append(form);
    attachWorkPanels(form);
    if (state.kind === "quote") {
      renderEstimateOptions();
      renderScope();
    }
    renderLines();
    updateRequiredFields();
    window.CeasefireProject?.refreshPages?.();
    if (state.kind === "quote" && document.version > 0) void refreshScopePreview();
  }
  const signatureDates = {requested_by:"requested_date",reviewed_by:"review_date",prepared_by:"prepared_date",client_approved_by:"client_approval_date",progress_by:"progress_date",closed_by:"closed_date",claimed_by:"claim_date",sent_by:"sent_date",verified_by:"verified_date"};
  async function signatureProfile() {
    const response = await fetch('/api/scheduler/bootstrap',{cache:'no-store'}), value = await response.json();
    if(!response.ok || typeof value.timezone !== 'string')throw new Error('Personal details could not be loaded. Try again.');
    return value;
  }
  async function signerName() {
    const response = await fetch('/api/certifications/defaults',{cache:'no-store'}), value = await response.json();
    if(!response.ok || typeof value.fields?.name !== 'string')throw new Error('Personal details could not be loaded. Try again.');
    return value.fields.name;
  }
  function signedDate(timezone) {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
  }
  function signatureField(fields, key, label) {
    const wrap = node("div","field commercial-signature"), buttonRow = node("div","commercial-signature-actions"), preview=node("div","commercial-signature-preview");
    wrap.dataset.signatureField=key;
    const value = fields.signatures?.[key];
    if (value) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${value.ratio * 100} 100`);
      svg.setAttribute("role","img"); svg.setAttribute("aria-label",label+" signature");
      for (const stroke of value.strokes) {
        const path = document.createElementNS(svg.namespaceURI,"polyline");
        path.setAttribute("points",stroke.map(p=>(p[0]*value.ratio*100)+","+(p[1]*100)).join(" "));
        path.setAttribute("fill","none"); path.setAttribute("stroke","currentColor"); path.setAttribute("stroke-width","1.5"); svg.append(path);
      }
      preview.append(svg);
    } else preview.append(node("span","helper","Not signed"));
    const selected = state.editor;
    const checkProgress = () => {
      if(key!=='progress_by')return;
      const rows=fields.work_tracking?.rows || [];
      if(rows.some(row=>row.completed_percent!=='' && (!Number.isFinite(Number(row.completed_percent)) || Number(row.completed_percent)<1 || Number(row.completed_percent)>100)))throw new Error('Enter a percentage from 1 to 100, or leave it blank.');
      if(!rows.some(row=>Number(row.completed_percent)>0))throw new Error('Record a completed percentage before signing work progress.');
    };
    const sign = button("", async () => {
      if (state.busy) return;
      try {checkProgress();}catch(error){message(error.message,true);return;}
      state.busy=true;setDisabled(true);
      try {
        const before=await signatureProfile();
        const result = await window.ClassifirePersonalSignature.choose(fields.signatures?.[key] || null);
        if (state.editor !== selected || !result) return;
        const name=await signerName(),after=await signatureProfile();
        if(state.editor !== selected)return;
        checkProgress();
        if((before.user?.id||null)!==(after.user?.id||null))throw new Error('Your signature profile changed. Reopen the signature pad.');
        const date=signedDate(after.timezone);
        (fields.signatures ||= {})[key] = result;
        fields.order[key]=name;fields.order[signatureDates[key]]=date;
        updateControls();
        markDirty(); wrap.replaceWith(signatureField(fields,key,label));
      } catch (error) { message(error.message,true); }
      finally {if(state.editor === selected){state.busy=false;setDisabled(false);}}
    });
    sign.classList.add("icon-only","personal-signature-button");
    sign.title = (value ? "Change " : "Sign ") + label;sign.setAttribute("aria-label",sign.title);
    window.CeasefireI18n?.attr(sign,'title',sign.title);window.CeasefireI18n?.attr(sign,'aria-label',sign.title);
    sign.append(node("span"));
    function updateControls() {
      for(const control of root().querySelectorAll('[data-order-field]'))if([key,signatureDates[key]].includes(control.dataset.orderField))control.value=fields.order[control.dataset.orderField]||'';
    }
    function reset() {
      if(state.busy || state.editor!==selected)return;
      delete (fields.signatures ||= {})[key];fields.order[key]='';fields.order[signatureDates[key]]='';
      updateControls();markDirty();wrap.replaceWith(signatureField(fields,key,label));
    }
    function resetButton(action,path) {
      const control=button('',reset);control.classList.add('icon-only');control.title=action+' '+label;control.setAttribute('aria-label',control.title);
      window.CeasefireI18n?.attr(control,'title',control.title);window.CeasefireI18n?.attr(control,'aria-label',control.title);
      const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','24');icon.setAttribute('height','24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.8');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');icon.setAttribute('aria-hidden','true');
      for(const d of path){const stroke=document.createElementNS(icon.namespaceURI,'path');stroke.setAttribute('d',d);icon.append(stroke);}control.append(icon);return control;
    }
    buttonRow.append(preview,sign,resetButton('Clear',['M20 7v5h-5','M4 17v-5h5','M6.1 8.4A7.5 7.5 0 0 1 19.2 10L20 12','M17.9 15.6A7.5 7.5 0 0 1 4.8 14L4 12']));
    const heading=node('span','',label);window.CeasefireI18n?.text(heading,label);
    wrap.append(heading,buttonRow);return wrap;
  }
  function attachWorkPanels(form) {
    const editor = state.editor, doc = editor.document, fields = doc.fields;
    const related = editor.source?.related || state.model.documents;
    const staged = new Map();
    const source = () => ({file_id:editor.source.file_id,revision:editor.source.revision});
    const panelWorkspace=state.workspace,panelContext=window.CeasefireProject?.runtimeContext?.();
    const current = () => state.editor === editor && state.workspace===panelWorkspace && panelWorkspace===currentWorkspace() && panelContext===window.CeasefireProject?.runtimeContext?.();
    const encode = blob => new Promise((resolve,reject)=>{
      const reader=new FileReader(); reader.onerror=()=>reject(new Error("The file could not be read."));
      reader.onload=()=>resolve(reader.result.split(",")[1]); reader.readAsDataURL(blob);
    });
    editor.panels=window.ClassifireWorkOrderPanels.attach(form, {
      fields, kind:doc.kind, id:doc.id, related, message, richEditor, canEdit:()=>current() && !state.busy, changeDetails:values=>{if(current() && !state.busy)editDocumentDetails(fields,values);}, projectDetails:projectDetailsSnapshot(editor.source), isSaved:()=>Boolean(doc.version),
      async writeNotes(notes) {
        if (!current() || state.busy) throw new Error("Finish the current document operation first.");
        if (!doc.version) { fields.notes=copy(notes); markDirty(); return; }
        state.busy=true;
        try {
          const saved = await documentRequest("notes",{workspace_id:state.workspace,id:doc.id,version:doc.version,notes},editor.source);
          if (!current()) return;
          fields.notes=saved.fields.notes || []; doc.version=saved.version; editor.pendingIssue=null;editor.pendingProjectDetails=null;
          if (!editor.source) changed();
          await load();
          if (!editor.source && !state.dirty) await saveActiveProject();
        } finally { state.busy=false; }
      },
      async upload(files) {
        if (!current() || state.busy) throw new Error("Finish the current document operation first.");
        state.busy=true;
        try {
          const existing=fields.files || [];
          if(existing.length+files.length>16 || files.some(f=>f.size>12*1024*1024) ||
              [...existing,...files].reduce((n,f)=>n+f.size,0)>32*1024*1024) throw new Error("Choose up to 16 files, 12 MiB per file and 32 MiB per document.");
          const incoming=[];
          for (const file of files) {
            const data={name:file.name,content:await encode(file)};
            const record=editor.source ? await request("saved-attachment",{source:source(),...data,
              ...(editor.source.file_id.startsWith("local-") ? {context_id:editor.source.documentId} : {})}) : await request("attachment",{workspace_id:state.workspace,...data});
            if (!current()) return;
            if (![...existing,...incoming].some(f=>f.id===record.id)) incoming.push(record);
            staged.set(record.id,file);
          }
          if(incoming.length) {fields.files=[...existing,...incoming];markDirty();}
        } finally {state.busy=false;}
      },
      async download(file) {
        let href, objectUrl=false;
        if(staged.has(file.id)) {href=URL.createObjectURL(staged.get(file.id));objectUrl=true;}
        else if(editor.source) {
          const data=await request("saved-read-attachment",{source:source(),id:doc.id,file_id:file.id});
          const raw=atob(data.content), bytes=Uint8Array.from(raw, ch=>ch.charCodeAt(0));
          href=URL.createObjectURL(new Blob([bytes],{type:data.mime}));objectUrl=true;
        } else href=`/api/commercial/attachment/${encodeURIComponent(file.id)}?workspace=${encodeURIComponent(state.workspace)}&document=${encodeURIComponent(doc.id)}`;
        const link=node("a"); link.href=href; link.download=file.name; link.click();
        if(objectUrl) setTimeout(()=>URL.revokeObjectURL(href),30000);
      },
      removeFile(file) {
        if (!current() || state.busy) return;
        fields.files=(fields.files || []).filter(f=>f.id!==file.id); staged.delete(file.id); markDirty();
      },
      async openRelated(card) {
        if (!current() || state.busy || (state.dirty && !await leaveEditor())) return;
        if (!await window.CeasefireProject.openCommercial(card.kind)) return;
        const actual=editor.source ? state.savedCards.find(item=>item.source_file===editor.source.file_id && item.id===card.id)
          : state.model.documents.find(item=>item.id===card.id);
        if(actual) await openCard(actual); else message("The linked document is unavailable. Refresh its board.",true);
      }
    });
  }
  function rateSchedule(fields) {
    const section = node("section", "card commercial-rate-schedule"), schedule = fields.rate_schedule;
    section.append(node("h2", "", "Schedule of Rates"), field("Schedule of Rates introduction", textarea(schedule.introduction, value => fields.rate_schedule.introduction = value)));
    const rates = node("div", "commercial-rate-grid");
    for (const [key, label, unit] of [
      ["ordinary_time", "Ordinary time", "per hour · 7:00am to 3:30pm"],
      ["time_and_half", "Time and a half", "per hour · 3:30pm to 5:30pm and night shifts"],
      ["double_time", "Double time", "per hour · after 5:30pm and weekends"],
      ["site_remobilisation", "Mobilisation", "per occasion"],
      ["equipment", "Equipment", "% added to Hire Rate"],
      ["materials", "Materials", "% added to Cost Rate"]
    ]) {
      const control = input(schedule.rates[key], value => { fields.rate_schedule.rates[key] = value; rememberRate(key, value, control); }, "number");
      control.dataset.rateKey = key;
      control.min = "0";
      control.max = "1000000000";
      control.step = "any";
      control.addEventListener("change", () => { if (control.dataset.rateInvalid !== "true") void flushRateDefaults().catch(() => {}); });
      const row = field(label, control);
      row.append(node("span", "helper", (key === "equipment" || key === "materials" ? "" : "AUD ") + unit));
      rates.append(row);
    }
    // Acceptance remains in the saved document and PDF, not the quote editor.
    section.append(rates);
    const remembered = node("div", "commercial-rate-defaults-notice"), status = node("p", "helper commercial-rate-defaults-status");
    status.setAttribute("role", "status");
    const retry = button("Retry remembering rates", () => void flushRateDefaults({retry:true}).catch(() => {}));
    retry.classList.add("commercial-rate-defaults-retry"); retry.hidden = true;
    window.CeasefireI18n?.text(retry, "Retry remembering rates");
    remembered.append(status, retry); section.append(remembered);
    // Reading defaults never replaces a saved document's own rate snapshot.
    void loadRateDefaults().catch(error => { rateDefaults.error = error; rateDefaultsNotice(); });
    queueMicrotask(rateDefaultsNotice);
    section.querySelectorAll("h2,.field>span").forEach(element => window.CeasefireI18n?.text(element, element.textContent));
    section.querySelectorAll("input,textarea").forEach(element => window.CeasefireI18n?.attr(element, "aria-label", element.getAttribute("aria-label")));
    return section;
  }
  function renderOrderFields(form, fields) {
    const references = node("section", "commercial-linked-reference");
    const isWorkOrder = state.kind === "work_order";
    const linkKey = isWorkOrder ? "quote_id" : "work_order_id";
    const projectNo=commercialProjectDetails(state.editor.source).project_no.trim();
    const choices = (state.editor.linkedQuote ? [state.editor.linkedQuote] : state.editor.source?.related || state.model.documents).filter(item => isWorkOrder
      ? item.kind === "quote" && item.last_number && item.fields.details.project_no.trim()===projectNo
      : item.kind === "work_order" && item.fields.order.work_order_reference);
    let costControl;
    let costEdited = Boolean(fields.order.estimated_cost);
    const quoteTotals = state.editor.source?.quoteTotals || state.model.quote_totals;
    const quoteRows = state.editor.source?.quoteRows || state.model.quote_rows;
    const trackingHosts = [];
    const initializeTracking = () => {
      const template=quoteRows?.[fields.order.quote_id]?.[fields.order.quote_reference];
      if(!fields.work_tracking && template)fields.work_tracking=copy(template);
    };
    const applyQuoteCost = (id, number) => {
      if (costEdited) return;
      fields.order.estimated_cost = quoteTotals?.[id]?.[number] || "";
      if (costControl) costControl.value = fields.order.estimated_cost;
    };
    if (isWorkOrder) {
      const quote = choices.find(item => item.id === fields.order.quote_id);
      applyQuoteCost(fields.order.quote_id, fields.order.quote_reference || quote?.last_number);
      initializeTracking();
    }
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
    linked.disabled = !!state.editor.linkedQuote || (isWorkOrder && state.editor.document.version > 0 && !!fields.order.work_order_reference);
    const reference = input(state.editor.document.reference || (isWorkOrder ? fields.order.work_order_reference : ""), () => {});
    reference.readOnly = true;
    reference.placeholder = "Assigned on first save";
    reference.dataset.orderReference = "true";
    linked.addEventListener("change", () => {
      fields.order[linkKey] = linked.value;
      const selected = choices.find(item => item.id === linked.value);
      if (isWorkOrder) {
        fields.order.quote_reference = selected?.last_number || "";
        delete fields.work_tracking;
        for(const key of ['progress_by','claimed_by']) {
          if(fields.signatures)delete fields.signatures[key];
          fields.order[key]='';fields.order[signatureDates[key]]='';
        }
        initializeTracking();
        trackingHosts.forEach(([host,key,label])=>renderTracking(host,key,label));
        for(const [key,label] of [['progress_by','Progress signed by'],['claimed_by','Claim signed by']]) {
          const signature=form.querySelector(`[data-signature-field="${key}"]`);
          if(signature)signature.replaceWith(signatureField(fields,key,label));
        }
        form.querySelectorAll('[data-order-field="progress_by"],[data-order-field="progress_date"],[data-order-field="claimed_by"],[data-order-field="claim_date"]').forEach(control=>control.value='');
        const linkedNumber=boundWorkOrderProjectNumber(state.editor) || commercialProjectDetails(state.editor.source).project_no;
        fields.details.project_no=linkedNumber;
        const number=root()?.querySelector('[data-project-detail="project_no"]');if(number)number.value=linkedNumber;
        applyQuoteCost(linked.value, fields.order.quote_reference);
      } else {
        fields.order.work_order_reference = selected?.fields.order.work_order_reference || "";
      }
      markDirty();
    });
    references.append(field(isWorkOrder ? "Linked Quote" : "Linked Work Order", linked), field(isWorkOrder ? "Work order reference" : "Purchase Order No.", reference));
    form.append(references);
    const groups = isWorkOrder ? [
      ["Work order details", [["start_date","Proposed start date"],["end_date","Proposed end date"],["urgency","Category / urgency"],["description","Description of works"],["estimated_cost","Estimated cost (AUD)"]]],
      ["Work order review", [["approval","Approval"],["justification","Justification"],["reviewed_by","Reviewed by"],["review_date","Review date"]]],
      ["OHS documentation", [["prepared_by","Prepared by"],["prepared_date","Date"]]],
      ["Client approval", [["client_approved_by","Approved by"],["client_approval_date","Approval date"]]],
      ["Works in Progress", [["completed_percent","% completed"],["progress_by","Progress signed by"],["progress_date","Date"]]],
      ["Work Order Claim", [["claimed_percent","% claimed"],["claimed_by","Claim signed by"],["claim_date","Date"]]],
      ["Work Order Completion", [["certification","Certification details"],["completion","Completion"],["closed_by","Closed by"],["closed_date","Date"]]]
    ] : [["Purchase order information", [["work_order_reference", "Work order reference"], ["supplier", "Supplier"], ["payment_terms", "Payment terms"], ["supplier_contact", "Supplier contact"], ["supplier_email", "Supplier email"], ["ship_to_name", "Site contact"], ["site_contact_number", "Site contact number"], ["delivery_method", "Delivery or pickup"], ["ship_to_address", "Ship to address"], ["delivery_date", "Delivery date and time"], ["expense_type", "Type of expense"]]], ["Request", [["requested_by", "Requested by"], ["requested_date", "Request date"]]], ["Approval", [["approval", "Approval"], ["rejection_reason", "Rejection reason"], ["reviewed_by", "Approved by"], ["review_date", "Approval date"]]], ["Sent by", [["sent_by", "Sent by"], ["sent_date", "Sent date"]]], ["Procurement verification", [["verification", "Verification method, specification, result and actions"], ["verified_by", "Verified by"], ["verified_date", "Verification date"]]]];
    for (const [title, items] of groups) {
      const section = node("section", "card commercial-order-fields");
      if(!isWorkOrder && title==='Purchase order information')section.classList.add('commercial-purchase-information');
      if(isWorkOrder && title==='Work order details')section.classList.add('commercial-work-details');
      section.append(node("h2", "", title));
      let dates,personPair,personDate,rejectionField;
      for (const [key, label] of items) {
        if(['completed_percent','claimed_percent'].includes(key)) {
          const tracking=node('div','commercial-work-tracking');tracking.dataset.trackingField=key;
          trackingHosts.push([tracking,key,label]);renderTracking(tracking,key,label);section.append(tracking);
          const legacy=fields.order[key==='completed_percent'?'progress':'claim'];
          if(legacy) {
            const disclosure=node('details','commercial-tracking-legacy');
            const summary=node('summary','','Previous notes');window.CeasefireI18n?.text(summary,'Previous notes');
            disclosure.append(summary,node('p','',legacy));section.append(disclosure);
          }
          continue;
        }
        if (["quote_reference", "work_order_reference"].includes(key)) continue;
        if (key === "estimated_cost") {
          costControl = input(fields.order.estimated_cost, value => {
            fields.order.estimated_cost = value;
            costEdited = Boolean(value);
          }, "number");
          costControl.step = "0.01";
          costControl.dataset.orderCost = "true";
          costControl.setAttribute("aria-label", label);
          const costFiles=node('div','commercial-work-cost-files');costFiles.append(field(label,costControl));section.append(costFiles);
          continue;
        }
        if (Object.hasOwn(signatureDates,key)) {
          const row=node('div','commercial-signer-row'),name=input(fields.order[key],value=>fields.order[key]=value);
          name.dataset.orderField=key;
          const nameField=field('Name',name);name.setAttribute('aria-label',label+' name');
          window.CeasefireI18n?.attr(name,'aria-label',label+' name');
          personPair=node('div','commercial-field-pair commercial-review-person-details');personPair.append(nameField);
          personDate=signatureDates[key];
          row.append(signatureField(fields,key,label),personPair);
          section.append(row);
          continue;
        }
        if(!isWorkOrder && key==='delivery_date') {
          const group=node('div','field commercial-delivery-field'),caption=node('span','',label),controls=node('div','commercial-delivery-datetime');
          const id='commercial-delivery-'+state.editor.document.id;
          caption.id=id;group.setAttribute('role','group');group.setAttribute('aria-labelledby',id);
          const date=input(fields.order.delivery_date,value=>fields.order.delivery_date=value,'date');
          const time=input(fields.order.delivery_time,value=>fields.order.delivery_time=value,'time');
          date.dataset.orderField='delivery_date';time.dataset.orderField='delivery_time';
          date.setAttribute('aria-label','Delivery date');time.setAttribute('aria-label','Delivery time');time.step='60';
          for(const control of [date,time])window.CeasefireI18n?.attr(control,'aria-label',control.getAttribute('aria-label'));
          controls.append(date,time);group.append(caption,controls);
          group.hidden=fields.order.delivery_method!=='Delivery';
          section.append(group);continue;
        }
        if(!isWorkOrder && ['supplier','supplier_contact','ship_to_name'].includes(key)) {
          const owner=state.editor, workspace=state.workspace, context=window.CeasefireProject?.runtimeContext?.();
          const current=()=>state.editor===owner && workspace===state.workspace && workspace===currentWorkspace() && context===window.CeasefireProject?.runtimeContext?.() && !state.busy;
          const account=data=>{
            if(fields.order.supplier_account_id)return data.accounts?.find(item=>item.id===fields.order.supplier_account_id);
            const fold=window.ClassifireCommercialDirectory.fold;
            const rows=(data.accounts || []).filter(item=>fold(item.company)===fold(fields.order.supplier));
            return rows.length===1?rows[0]:null;
          };
          function update(values){if(!current())return;Object.assign(fields.order,values);section.querySelectorAll('[data-order-field]').forEach(control=>control.value=fields.order[control.dataset.orderField] || '');markDirty();}
          const search=window.ClassifireCommercialDirectory.field(label,{kind:key==='supplier'?'accounts':'contacts',value:fields.order[key],read:()=>fields.order[key],isCurrent:current,message,
            account:key==='ship_to_name' ? undefined : account,filter: key==='supplier_contact' ? (contact,data)=>!fields.order.supplier || !!account(data) && (contact.account_id===account(data).id || contact.account_id===undefined && window.ClassifireCommercialDirectory.fold(contact.company)===window.ClassifireCommercialDirectory.fold(fields.order.supplier)) : undefined,
            onInput(value){
              if(value===fields.order[key])return;
              if(key==='supplier')update({supplier:value,supplier_account_id:'',supplier_contact:'',supplier_contact_id:'',supplier_email:''});
              else if(key==='supplier_contact')update({supplier_contact:value,supplier_contact_id:'',...(fields.order.supplier_contact_id || !value ? {supplier_email:''}:{})});
              else update({ship_to_name:value,site_contact_id:'',...(fields.order.site_contact_id || !value ? {site_contact_number:''}:{})});
            },onSelect(item,data){
              if(key==='supplier'){
                const different=fields.order.supplier_account_id ? item.id!==fields.order.supplier_account_id : item.company!==fields.order.supplier;
                update({supplier:item.company,supplier_account_id:item.id,...(different?{supplier_contact:'',supplier_contact_id:'',supplier_email:''}:{})});
              }else if(key==='ship_to_name')update({ship_to_name:item.name,site_contact_id:item.id,site_contact_number:item.phone || ''});
              else {
                const company=data.accounts?.find(company=>company.id===item.account_id);
                update({supplier_contact:item.name,supplier_contact_id:item.id,supplier_email:item.email || '',supplier_account_id:item.account_id || '',supplier:company?.company || item.company || ''});
              }
            }});
          search.input.dataset.orderField=key;section.append(search.element);continue;
        }
        const choices = isWorkOrder ? (key === "urgency" ? ["High Priority","Medium Priority","Low Priority"] : key === "approval" ? ["Approved","Denied"] : key==='certification' ? ['Certification issued','Certification not issued'] : key==='completion' ? ['Completed','Ongoing','On hold','Not completed'] : null)
          : key === "approval" ? ["Approved", "Rejected"] : key === "expense_type" ? ["Labour", "Materials", "Services", "Hire", "Other"] : key === "delivery_method" ? ["Delivery", "Pickup"] : null;
        let control;
        if (choices) {
          const options = ["",...choices];
          if (fields.order[key] && !options.includes(fields.order[key])) options.push(fields.order[key]);
          control = select(options, fields.order[key], value => {
            fields.order[key] = value;
            if(!isWorkOrder && key==='approval' && rejectionField)rejectionField.hidden=value!=='Rejected';
            if(!isWorkOrder && key==='delivery_method') {
              const delivery=section.querySelector('.commercial-delivery-field');
              if(delivery)delivery.hidden=value!=='Delivery';
            }
          });
          for(const option of control.options)if(choices.includes(option.value))window.CeasefireI18n?.text(option,option.value);
        } else control = key.endsWith("_date") ? input(fields.order[key], value => fields.order[key] = value, "date")
          : key==='site_contact_number' ? input(fields.order[key], value => fields.order[key]=value, 'tel') : textarea(fields.order[key], value => fields.order[key] = value);
        if(key==='site_contact_number')control.maxLength=60;
        if(!isWorkOrder && key==='rejection_reason')control.maxLength=1000;
        if(isWorkOrder && key==='justification')control.rows=1;
        if(!isWorkOrder && title==='Purchase order information' && control.tagName==='TEXTAREA')control.rows=1;
        control.dataset.orderField=key;
        const item = field(label, control);
        if(!isWorkOrder && key==='rejection_reason'){rejectionField=item;item.hidden=fields.order.approval!=='Rejected';}
        if(isWorkOrder && key==='description')item.classList.add('commercial-work-description');
        if(isWorkOrder && key==='justification')item.classList.add('commercial-work-justification');
        if (isWorkOrder && ["start_date","end_date"].includes(key)) {
          if (!dates) { dates = node("div", "commercial-field-pair commercial-proposed-dates"); section.append(dates); }
          dates.append(item);
        } else if(key===personDate && personPair)personPair.append(item);
        else section.append(item);
      }
      form.append(section);
      section.querySelectorAll('h2,.field>span').forEach(element=>window.CeasefireI18n?.text(element,window.CeasefireI18n.source(element)));
      if (!isWorkOrder && title === "Purchase order information") {
        form.append(node("section", "commercial-lines"), button("Add line item", () => {
          fields.lines.push({estimate_id: "", description: "", quantity: "1", unit_price: "0", size: "", comments: ""});
          markDirty(); renderLines();
        }), node("div", "commercial-totals"));
      }
    }
    function renderTracking(host,key,label) {
      host.replaceChildren();
      if(!fields.work_tracking) {
        const text=fields.order.quote_id ? 'The original issued Quote rows are unavailable.' : 'Select an issued Quote to track work.';
        const notice=node('p','helper',text);window.CeasefireI18n?.text(notice,text);host.append(notice);return;
      }
      const table=node('table'),head=node('thead'),headers=node('tr'),body=node('tbody');
      const progress=key==='completed_percent';
      ['Product / Service','Quantity',progress?'Notes':'Unit price',label].forEach(text=>{const header=node('th','',text);window.CeasefireI18n?.text(header,text);headers.append(header);});
      head.append(headers);
      fields.work_tracking.rows.forEach((row,index)=>{
        const tr=node('tr');tr.dataset.trackingLine=row.line_id;
        [row.description,row.quantity].forEach(text=>tr.append(node('td','',text)));
        const noteCell=node('td');
        if(progress) {
          const note=textarea(row.notes || '',value=>{
            const current=fields.work_tracking?.rows.find(item=>item.line_id===row.line_id);
            if(current)current.notes=value;
          });
          note.rows=1;note.maxLength=2000;note.dataset.trackingNotes=row.line_id;
          note.setAttribute('aria-label',`Notes ${index+1}`);window.CeasefireI18n?.attr(note,'aria-label','Notes {0}',[index+1]);noteCell.append(note);
        } else noteCell.textContent=trackingMoney.format(Number(row.unit_price));
        tr.append(noteCell);
        const cell=node('td'),lineId=row.line_id;
        // Saving replaces the returned row objects. Resolve the current owned
        // row on each edit so a second Save cannot lose later percentage edits.
        const control=input(row[key],value=>{
          const current=fields.work_tracking?.rows.find(item=>item.line_id===lineId);
          if(current)current[key]=value;
        },'number');
        control.min='1';control.max='100';control.step='any';control.setAttribute('aria-label',`${label} ${index+1}`);
        window.CeasefireI18n?.attr(control,'aria-label',label+' {0}',[index+1]);
        cell.append(control);tr.append(cell);body.append(tr);
      });
      table.append(head,body);host.append(table);
    }
  }
  function renderEstimateOptions() {
    const container = root()?.querySelector(".commercial-estimate-options");
    if (!container) return;
    container.replaceChildren();
    const selected = new Set(linkedIds(state.editor.document.fields.lines));
    for (const estimate of state.editor.source?.estimates || window.CeasefireEstimates?.list?.() || [{
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
    if (state.editor?.source) return {estimates: state.editor.source.estimates};
    if (!window.CeasefireEstimates?.capture) throw new Error("The project estimate workspace is unavailable.");
    return window.CeasefireEstimates.capture(options);
  }
  async function deriveCaptured(editor, workspace, captured, selectedIds, full = false) {
    // One result per exact captured estimate, confined to this editor. Sharing
    // in-flight work also prevents the read-only preview and a selection change
    // recalculating the same large schedule. Save and issue always revalidate.
    const available = new Map(captured.estimates.map(item => [item.id, item]));
    const missing = [];
    for (const id of selectedIds) {
      const item = available.get(id);
      if (!item) throw new Error("Choose estimates from the current project.");
      const fingerprint = JSON.stringify(item);
      let cached = editor.derivedEstimates.get(id);
      if (cached?.fingerprint !== fingerprint) {
        cached = {fingerprint, captured}; editor.derivedEstimates.set(id, cached);
      }
      if (!(full ? cached.full : cached.fullValue || cached.preview)) missing.push({id, cached});
    }
    if (missing.length) {
      const needed = new Set(missing.map(item => item.id));
      const pending = documentRequest("derive", {workspace_id: workspace, ...captured,
        estimates:captured.estimates.filter(item => needed.has(item.id)), selected_ids: [...needed],
        ...(!full ? {include_scope_tables:false} : {})}, editor.source);
      for (const {id, cached} of missing) {
        const key = full ? "full" : "preview";
        cached[key] = pending.then(result => {
          const group = result.scope_groups.find(item => item.estimate_id === id);
          const value = {
            line: result.lines.find(item => item.estimate_id === id),
            source: result.sources.find(item => item.estimate_id === id),
            scope: group.scope,
            tables: result.scope_tables.slice(group.table_start, group.table_start + group.table_count)
          };
          cached[full ? "fullValue" : "previewValue"] = value;
          if (full) cached.fullError = null;
          return value;
        }).catch(error => {
          if (editor.derivedEstimates.get(id) === cached) {
            delete cached[key];
            if (full) cached.fullError = error;
            else if (!cached.full) editor.derivedEstimates.delete(id);
          }
          throw error;
        });
      }
    }
    const selected = await Promise.all(selectedIds.map(id => {
      const cached = editor.derivedEstimates.get(id);
      return full ? cached.full : cached.fullValue || cached.preview;
    }));
    return {lines: selected.map(item => item.line), sources: selected.map(item => item.source),
      scope: selected.map(item => item.scope).join(""), scope_tables: selected.flatMap(item => item.tables),
      preview_tables:selected.flatMap((item,index) => item.tables.map((table,tableIndex) => ({...table,previewKey:`${selectedIds[index]}/${tableIndex}`})))};
  }
  async function loadScopeTables(estimateId, editor) {
    const cached = editor.derivedEstimates.get(estimateId), workspace = state.workspace;
    const context = window.CeasefireProject?.runtimeContext?.();
    const current = () => state.editor === editor && workspace === state.workspace && workspace === currentWorkspace()
      && context === window.CeasefireProject?.runtimeContext?.() && editor.derivedEstimates.get(estimateId) === cached;
    if (!cached) throw new Error("The selected estimate changed. Select it again to refresh its schedule.");
    try {
      await deriveCaptured(editor, workspace, cached.captured, [estimateId], true);
      if (!current()) return;
      editor.scopeTables = linkedIds(editor.document.fields.lines).flatMap(id => {
        const entry = editor.derivedEstimates.get(id);
        return ((entry?.fullValue || entry?.previewValue)?.tables || []).map((table,index)=>({...table,previewKey:`${id}/${index}`}));
      });
      renderScope();
    } catch (error) {
      if (current()) renderScope();
      throw error;
    }
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
      const captured = await capturedEstimates({readOnly:true, commercial:true});
      if (!current()) return;
      const derived = await deriveCaptured(editor, workspace, captured, linkedIds(editor.document.fields.lines));
      if (!current()) return;
      editor.scopeTables = derived.preview_tables;
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
      const captured = await capturedEstimates({commercial:true});
      if (editor !== state.editor || workspace !== state.workspace || context !== window.CeasefireProject?.runtimeContext?.()) return;
      const derived = await deriveCaptured(editor, workspace, captured, selectedIds);
      if (editor !== state.editor || workspace !== state.workspace || workspace !== currentWorkspace() || context !== window.CeasefireProject?.runtimeContext?.()) return;
      const fields = editor.document.fields,
        previous = new Map(fields.lines.map(line => [line.estimate_id, line]));
      const customLines = fields.lines.filter(line => !line.estimate_id);
      fields.lines = derived.lines.map(line => ({
        ...line,
        size: "",
        comments: "",
        ...(previous.has(line.estimate_id) ? {
          description: previous.get(line.estimate_id).description,
          quantity: previous.get(line.estimate_id).quantity
        } : {})
      })).concat(customLines);
      fields.scope_tables = derived.scope_tables;
      editor.scopeTables = derived.preview_tables;
      fields.sources = derived.sources;
      if (!fields.scope || fields.scope === editor.generatedScope) fields.scope = derived.scope;
      editor.generatedScope = derived.scope;
      markDirty();
      renderEstimateOptions();
      renderLines();
      renderScope();
      message("");
      return true;
    } catch (error) {
      if (editor === state.editor && workspace === state.workspace) {
        message(error.message, true);
        renderEstimateOptions();
      }
      return false;
    } finally {
      if (editor === state.editor && workspace === state.workspace) {
        state.busy = false;
        setDisabled(false);
      }
    }
  }
  function renderLines() {
    const host = root()?.querySelector(".commercial-lines");
    if (!host || !state.editor) return;
    clearPricingPickers();
    host.replaceChildren(node("h2", "", state.kind === "quote" ? "Quote summary" : "Request summary"));
    const owner=state.editor,workspace=state.workspace,context=window.CeasefireProject?.runtimeContext?.();
    const fields = state.editor.document.fields,
      table = node("table"),
      head = node("thead"),
      header = node("tr");
    if(state.kind==='purchase_order')table.classList.add('commercial-po-lines');
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
      const descriptionInput = state.kind === "purchase_order" ? input(line.description, value => line.description=value) : textarea(line.description,value=>line.description=value);
      if(state.kind==='purchase_order')descriptionInput.type='search';
      descriptionInput.rows = 1;
      descriptionInput.classList.add("commercial-line-description");
      descriptionInput.setAttribute("aria-label", `Product / Service ${index + 1}`);
      const resize = () => { if (descriptionInput.tagName === "TEXTAREA") resizeDescription(descriptionInput); };
      descriptionInput.addEventListener("input", resize);
      const descriptionControls = node("div", "commercial-line-description-controls");
      descriptionControls.append(descriptionInput);
      description.append(descriptionControls);
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
      price.readOnly = state.kind === "quote" && !!line.estimate_id;
      unit.append(price);
      if(state.kind==='purchase_order' || state.kind==='quote' && !line.estimate_id){
        const cleanup=window.ClassifireCommercialPricing?.attach(descriptionInput,{
        ...(state.kind==='purchase_order' ? {searchItems:async query=>{
          const data=await request('supplier-products?workspace='+encodeURIComponent(workspace));
          const needle=query.trim().toLocaleLowerCase();
          return data.products.map((item,index)=>({...item,searchId:String(index)})).filter(item=>[item.label,item.code].join(' ').toLocaleLowerCase().includes(needle)).slice(0,30).map(item=>({id:item.searchId,name:item.label,description:item.label,unit_price:Number(item.supplier_price ?? 0),supplierPrice:item.supplier_price}));
        }} : {}),
        isCurrent:()=>!state.busy && state.editor===owner && workspace===state.workspace && workspace===currentWorkspace()
          && context===window.CeasefireProject?.runtimeContext?.() && row.isConnected && fields.lines.includes(line),
        onSelect(item){
          line.description=item.description;line.unit_price=state.kind==='purchase_order' && item.supplierPrice==null ? '' : String(Number(Number(item.unit_price).toFixed(6)));
          if(state.kind==='purchase_order' && item.supplierPrice==null)message('No supplier price is recorded for this item. Enter its purchase price.');
          descriptionInput.value=line.description;price.value=line.unit_price;
          resize();markDirty();renderTotals();
        }
        });
        if(typeof cleanup==='function')(owner.pricingCleanups ||= []).push(cleanup);
      }
      row.append(description, quantity, unit, total);
      if (state.kind === "quote" && !line.estimate_id) {
        const remove = button("", () => {
          fields.lines.splice(index, 1);
          markDirty();
          renderLines();
        });
        remove.classList.add("icon-only", "commercial-remove-row");
        remove.setAttribute("aria-label", "Remove row"); remove.title = "Remove row";
        window.CeasefireI18n?.attr(remove, "aria-label", "Remove row");
        window.CeasefireI18n?.attr(remove, "title", "Remove row");
        remove.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
        descriptionControls.append(remove);
      }
      if (state.kind === "purchase_order") {
        const size = node("td"),
          comments = node("td"),
          actions = node("td");
        size.append(input(line.size, value => line.size = value));
        const comment = textarea(line.comments, value => line.comments = value);
        comment.rows = 1; comment.classList.add("commercial-line-comments");
        comment.setAttribute("aria-label", `Comments ${index+1}`);
        comment.addEventListener("input", () => resizeDescription(comment));
        requestAnimationFrame(() => resizeDescription(comment)); comments.append(comment);
        const remove = button("", () => {
          fields.lines.splice(index, 1);
          markDirty();
          renderLines();
        });
        remove.classList.add("icon-only", "commercial-remove-line");
        remove.setAttribute("aria-label", "Remove line item"); remove.title = "Remove line item";
        remove.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
        actions.append(remove);
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
    const opened = new Set([...host.querySelectorAll("details[open]")].map(item => item.dataset.scopeKey));
    host.replaceChildren(node("h2", "", "Scope of Works"));
    host.append(node("p", "helper", "The PDF includes the complete Full Schedule for every selected estimate."));
    for (const [index, scope] of state.editor.scopeTables.entries()) {
      const details = node("details"),
        table = node("table"),
        head = node("thead"),
        header = node("tr");
      const scopeKey = scope.previewKey || `saved/${index}`;
      details.dataset.scopeKey = scopeKey;
      details.append(node("summary", "", scope.title));
      if (scope.pending) {
        const editor = state.editor, cached = editor.derivedEstimates.get(scope.estimate_id);
        const notice = node("p", "helper", cached?.fullError ? "The schedule could not be loaded. Retry to view its rows." : "Expand to load the complete schedule.");
        const retry = button("Retry loading schedule", () => void load()); retry.hidden = !cached?.fullError;
        let loading = false;
        const load = async () => {
          if (loading) return; loading = true; retry.disabled = true; details.setAttribute("aria-busy", "true");
          notice.textContent = "Loading schedule…";
          try { await loadScopeTables(scope.estimate_id, editor); }
          catch { /* The current editor renders its retry state after failure. */ }
          finally { loading = false; details.removeAttribute("aria-busy"); }
        };
        details.append(notice, retry);
        details.addEventListener("toggle", () => { if (details.open && !cached?.fullError) void load(); });
        details.open = opened.has(scopeKey); host.append(details); continue;
      }
      scope.headers.forEach(text => header.append(node("th", "", text)));
      head.append(header);
      table.append(head);
      const body = node("tbody");
      let populated = false;
      details.addEventListener("toggle", () => {
        if (!details.open || populated) return;
        populated = true;
        const rows = document.createDocumentFragment();
        scope.rows.forEach(values => {
          const row = node("tr");
          values.forEach(value => row.append(node("td", "", value)));
          rows.append(row);
        });
        body.append(rows);
      });
      table.append(body);
      const scroll = node("div", "table-scroll");
      scroll.append(table);
      details.append(scroll);
      details.open = opened.has(scopeKey);
      host.append(details);
    }
  }
  function setDisabled(disabled) {
    if(disabled)state.editor?.panels?.closeSearches();
    root()?.querySelectorAll(".commercial-work-layout button,.commercial-work-layout input,.commercial-work-layout textarea,.commercial-work-layout select").forEach(control => control.disabled = disabled);
    root()?.querySelectorAll(".commercial-rich-input").forEach(control => control.contentEditable = String(!disabled));
    if (!disabled && state.kind === "work_order" && (state.editor?.linkedQuote || (state.editor?.document.version > 0 && state.editor.document.fields.order.work_order_reference))) {
      const linked = root()?.querySelector('[data-order-link="quote_id"]');
      if (linked) linked.disabled = true;
      const number = root()?.querySelector('input[aria-label="Project number"]');
      if (number) number.readOnly = true;
    }
  }
  function captureDocumentOperation() {
    const editor=state.editor,projectDetails=projectDetailsSnapshot(editor?.source);
    return {editor,workspace:state.workspace,context:window.CeasefireProject?.runtimeContext?.(),projectDetails,
      projectFingerprint:JSON.stringify(projectDetails)};
  }
  function assertDocumentOperation(operation) {
    if(operation.editor!==state.editor || operation.workspace!==state.workspace || operation.workspace!==currentWorkspace()
      || operation.context!==window.CeasefireProject?.runtimeContext?.()
      || operation.projectFingerprint!==JSON.stringify(projectDetailsSnapshot(operation.editor.source)))
      throw new Error("The Project details changed while saving. Reopen this document to use the current Project details.");
  }
  function validateProjectDetailEdit(operation) {
    if(operation.editor.source)return;
    const details=operation.projectDetails,previous=operation.editor.projectOriginal;
    const changed=previous && (Object.hasOwn(previous,'client') && details.client!==previous.client
      || previous.account_id && !details.account_id);
    if(changed && details.client && !details.account_id)
      throw new Error("Choose an existing Company for this Client, or add a new Company.");
  }
  async function persist(captured, explicitlySaved, operation) {
    assertDocumentOperation(operation);
    validateProjectDetailEdit(operation);
    const {editor,workspace,projectDetails}=operation, document=editor.document;
    const lockedNumber=boundWorkOrderProjectNumber(editor);
    if(!editor.source)applyProjectDetails(document.fields,commercialProjectDetails());
    if(lockedNumber)document.fields.details.project_no=lockedNumber;
    const saved = await documentRequest("save", {
      workspace_id: workspace,
      id: document.id,
      version: document.version,
      kind: document.kind,
      status: document.status,
      fields: document.fields,
      ...(!editor.source ? {project_details:projectDetails} : editor.source.projectUpdates ? {project_updates:editor.source.projectUpdates} : {}),
      ...(explicitlySaved && !state.editor.source && !window.CeasefireProject.context().project_token ? {retain_unfiled:true} : {}),
      ...captured
    }, state.editor.source);
    assertDocumentOperation(operation);
    adoptSaved(saved);
    if (state.editor.source) {state.editor.source.documentId = saved.id;delete state.editor.source.projectUpdates;}
    delete editor.projectOriginal;delete editor.projectApplied;delete editor.projectBaseline;
    state.dirty = false;
    if (!state.editor.source) changed();
    await load();
    assertDocumentOperation(operation);
    return saved;
  }
  function adoptSaved(saved) {
    const fields = state.editor.document.fields;
    state.editor.derivedEstimates.clear();
    ++state.editor.scopeRevision;
    Object.assign(fields, saved.fields);
    state.editor.scopeTables = copy(fields.scope_tables || []);
    Object.assign(state.editor.document, saved, {
      fields
    });
    renderLines();
    renderScope();
    const reference = root()?.querySelector("[data-order-reference]");
    if (reference) reference.value = saved.reference || "";
    const cost = root()?.querySelector("[data-order-cost]");
    if (cost) cost.value = fields.order.estimated_cost;
    root()?.querySelectorAll('[data-project-detail]').forEach(control=>{control.value=fields.details[control.dataset.projectDetail] || '';});
    state.editor.panels?.refreshProjectDetails(projectDetailsSnapshot(state.editor.source));
  }
  async function saveEditor() {
    if (state.busy || !state.editor) return;
    try {validateReadiness('save');} catch(error) {message(error.message,true);return;}
    const operation=captureDocumentOperation();
    state.busy = true;
    setDisabled(true);
    try {
      if(!operation.editor.source) {
        validateProjectDetailEdit(operation);
        await window.CeasefireProjectPane?.beforeProjectSave?.();
      }
      await flushRateDefaults();
      assertDocumentOperation(operation);
      const captured = state.kind === "quote" ? await capturedEstimates() : {};
      await persist(captured, true, operation);
      const source = state.editor.source;
      const inFile = source ? !source.file_id.startsWith("local-") : await saveActiveProject();
      message(inFile
        ? "Document saved. Its linked project file is updated." : "Document saved. It is available on the board.");
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
      setDisabled(false);
    }
  }
  async function downloadEditor() {
    if (state.busy || !state.editor) return;
    try {validateReadiness('issue');} catch(error) {message(error.message,true);return;}
    const operation=captureDocumentOperation();
    state.busy = true;
    setDisabled(true);
    try {
      if(!operation.editor.source) {
        validateProjectDetailEdit(operation);
        await window.CeasefireProjectPane?.beforeProjectSave?.();
      }
      await flushRateDefaults();
      assertDocumentOperation(operation);
      if(state.editor.pendingIssue && state.editor.pendingProjectDetails!==JSON.stringify(projectDetailsSnapshot(state.editor.source))) {
        state.editor.pendingIssue=null;state.editor.pendingProjectDetails=null;
      }
      if (!state.editor.pendingIssue) {
        const captured = state.kind === "quote" ? await capturedEstimates() : {},
          saved = await persist(captured, false, operation);
        state.editor.pendingIssue = {
          workspace_id: state.workspace,
          id: saved.id,
          kind: saved.kind,
          version: saved.version,
          request_id: crypto.randomUUID(),
          ...captured
        };
        state.editor.pendingProjectDetails=JSON.stringify(projectDetailsSnapshot(state.editor.source));
      }
      const source = state.editor.source;
      const result = source ? await documentRequest("issue", state.editor.pendingIssue, source) : await window.CeasefireDownloads.save("/api/commercial/issue", state.editor.pendingIssue, {
        button: root().querySelector(".commercial-download-pdf")
      });
      if (result?.cancelled) {
        message("Download cancelled.");
        return;
      }
      state.editor.pendingIssue = null;
      state.editor.pendingProjectDetails = null;
      if (!source) changed();
      await load();
      const latest = source ? result.document : state.model.documents.find(document => document.id === state.editor.document.id);
      if (latest) adoptSaved(copy(latest));
      else renderBoard();
      window.CeasefireNotifications?.rememberDownload?.(result);
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
    if ((state.busy && !state.syncingProject) || state.dirty) throw new Error("Save or discard commercial document edits before saving the project.");
    const workspace = currentWorkspace();
    if (!workspace) return null;
    const result = await request(`state?workspace=${encodeURIComponent(workspace)}`);
    return result.snapshot;
  }
  function clearPricingPickers() {
    state.editor?.pricingCleanups?.forEach(cleanup=>cleanup());
    if(state.editor)state.editor.pricingCleanups=[];
  }
  window.CeasefireCommercial = {
    activate, leaveEditor,
    projectDetailsChanged() {
      if(state.editor && !state.editor.source)refreshEditorProjectDetails();
      else if(!state.editor && state.model)renderCards();
    },
    projectNumberAssigned(details) {
      const document = state.editor?.document;
      if (!document || state.editor.source || document.fields.details.project_no || !details?.project_no) return;
      document.fields.details.project_no = details.project_no;
      const control = root()?.querySelector('input[aria-label="Project number"]');
      if (control) control.value = details.project_no;
      if (!document.version) markDirty();
    },
    async openFromEstimate(kind = "quote") {
      if (!names[kind]) return;
      if (state.busy || state.dirty || !requireProject()) return;
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
      clearPricingPickers();
      state.workspace = prepared?.workspace_id || null;
      state.model = null;
      state.editor = null;
      state.dirty = false;
      state.busy = false;
      state.changed = false;
      state.revision++;
    },
    projectFingerprint() {
      return JSON.stringify({
        workspace: state.workspace,
        documents: state.model?.snapshot,
        editor: state.editor?.document,
        editor_project_details: state.editor ? projectDetailsSnapshot(state.editor.source) : null,
        pending_project_details:state.editor?.pendingProjectDetails,
        dirty: state.dirty
      });
    },
    hasPendingOperation() {
      return state.busy || state.dirty || Boolean(rateDefaults.saving || rateDefaults.pending.size);
    },
    hasProjectChanges() {
      return state.changed || state.dirty;
    },
    markProjectSaved(saved, captured) {
      if (!captured || JSON.stringify(state.model?.snapshot) === JSON.stringify(captured)) state.changed = false;
    }
  };
  window.addEventListener("beforeunload", event => {
    if (rateDefaults.saving || rateDefaults.pending.size) { event.preventDefault(); event.returnValue = ""; }
  });
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
  const positionOpenMenus = () => document.querySelectorAll(".commercial-card-menu[open]").forEach(positionCardMenu);
  window.addEventListener("resize", positionOpenMenus);
  window.addEventListener("resize", () => {
    document.querySelectorAll("textarea.commercial-line-description,.commercial-line-comments").forEach(resizeDescription);
  });
  document.addEventListener("scroll", event => {
    if (!event.target.closest?.(".commercial-menu-options")) positionOpenMenus();
  }, true);
})();
