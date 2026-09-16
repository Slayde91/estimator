"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    fields: [], currentFields: [], inputs: {}, catalog: { inventory: [], rate_groups: {} }, baseline: { inventory: [], rate_groups: {} },
    configuration: { inventory: {}, rates: {} }, draft: { inventory: {}, rates: {} },
    quote: null, quoteConfiguration: null, quoteContext: 0, quoteLoadRevision: 0, dirty: false, pricingDirty: false,
    result: null, revision: 0, timer: null, controller: null, pricingExpanded: new Set(), legacyTitle: "",
    workflow: "", defaultWorkflow: "Intumescent spray to ductwork", inputErrors: new Map(), inputDrafts: new Map(), inputRevision: 0, projectBusy: false,
  };
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const quantity = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percentCells = new Set(["B9", "B26", "B27", ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const wholeCells = new Set(["B4", "B8", "B9", "B26", "B27", "F27", "F28", ...Array.from({ length: 9 }, (_, i) => `B${i + 15}`), ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const materialNames = [
    ["Spraying", "Bags / drums"], ["Meshing", "m²"], ["Pins / clips", "m²"],
    ["Access panels", "Number of panels"], ["PromaMesh / fan enclosures", "m²"],
    ["Primer", "m²"], ["Topcoat", "m²"], ["Board", "m²"], ["Mastic", "Linear metres"],
  ];
  const groups = {
    access_hire: "Access hire", labour_rates: "Labour", masking_rates: "Masking",
    freight_rates: "Freight", LAFHA_rates: "Accommodation", travel_rates: "Travel",
    access_panels: "Access panels", mesh: "Mesh", pins: "Pins / clips", sprays: "Sprays",
    boards: "Boards", mastic: "Mastic", primers: "Primers", topcoats: "Topcoats",
  };
  const additionLabels = {
    E26: "Extra days · labour team", F26: "Extra labour days",
    E27: "Site mobilisation fee", F27: "Mobilisation count",
    E28: "Administration fee", F28: "Administration count",
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const formatNumber = (value) => isNumber(value) ? quantity.format(value) : value == null || value === "" ? "—" : String(value);
  const formatMoney = (value) => isNumber(value) ? money.format(value) : "—";
  const fieldByCell = (cell) => state.fields.find((field) => field.cell === cell);

  function quoteDetails() {
    return { project_no: $("project-no").value.trim(), client: $("client").value.trim(), site_address: $("site-address").value.trim() };
  }

  function updateQuoteTitle() {
    const details = quoteDetails();
    $("quote-title").value = [details.project_no, details.client, details.site_address].filter(Boolean).join("- ") || state.legacyTitle || "Untitled quote";
    $("project-name").textContent = $("quote-title").value;
  }

  function controlValue(value, percent = false) {
    return isNumber(value) ? controlNumber.format(Number(percent ? shiftDecimal(value, 2) : value)) : value ?? "";
  }

  function editedNumber(control, percent = false) {
    if (control.validity.badInput) return "Invalid number";
    if (control.value === "") return "";
    const numeric = Number(control.value);
    if (!Number.isFinite(numeric)) return "Invalid number";
    const displayed = controlNumber.format(numeric);
    // Untouched imported values remain full precision in state. An intentional
    // edit is limited to the two decimal places the estimator can see.
    if (Number(displayed) !== numeric) control.value = displayed;
    return Number(percent ? shiftDecimal(displayed, -2) : displayed);
  }

  function estimateControlValue(field, value) {
    if (field.cell === "B28") return isNumber(value) ? money.format(value) : value ?? "";
    // Existing fractional snapshots stay visible and exact until deliberately edited.
    if (wholeCells.has(field.cell)) return isNumber(value) ? String(isPercent(field) ? shiftDecimal(value, 2) : value) : value ?? "";
    return controlValue(value, isPercent(field));
  }

  function editedEstimateNumber(control, field) {
    if (field.cell === "B28") {
      const raw = control.value.trim().replace(/^(-?)\$\s*/, "$1").replace(/,/g, "");
      if (!raw) return "";
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw))) return "Invalid currency amount";
      return Number(controlNumber.format(Number(raw)));
    }
    if (wholeCells.has(field.cell)) {
      if (control.validity.badInput || control.value !== "" && !Number.isInteger(Number(control.value))) return "Enter a whole number with no decimal places";
      return control.value === "" ? "" : Number(isPercent(field) ? shiftDecimal(control.value, -2) : control.value);
    }
    return editedNumber(control, isPercent(field));
  }

  function inputProblem() { return [...state.inputErrors.values()][0] || ""; }

  function showInputProblems() {
    clearResults("Check inputs");
    const box = $("calculation-errors"); box.textContent = [...state.inputErrors.values()].join("\n"); box.hidden = false;
    for (const cell of state.inputErrors.keys()) $(`input-${cell}`)?.setAttribute("aria-invalid", "true");
  }

  // Move the decimal point in its text representation, retaining all entered digits.
  function shiftDecimal(value, places) {
    const match = String(value).match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return String(value);
    const digits = (match[2] || "") + (match[3] || "");
    const position = (match[2] || "").length + Number(match[4] || 0) + places;
    if (position <= 0) return `${match[1]}0.${"0".repeat(-position)}${digits}`;
    if (position >= digits.length) return `${match[1]}${digits}${"0".repeat(position - digits.length)}`.replace(/^([+-]?)0+(?=\d)/, "$1");
    return `${match[1]}${digits.slice(0, position)}.${digits.slice(position)}`.replace(/^([+-]?)0+(?=\d)/, "$1");
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function message(text, error = false) {
    const box = $("app-message");
    box.textContent = text;
    box.className = `message${error ? " error" : ""}`;
    box.hidden = !text;
    box.setAttribute("role", error ? "alert" : "status");
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const detail = data.error || data.message || `Request failed (${response.status}).`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  }

  function updateDirty(value = true) {
    state.dirty = value;
    $("quote-status").textContent = `${state.quote ? "Saved quote" : "New estimate"}${value ? " · Unsaved changes" : ""}`;
  }

  function isPercent(field) {
    return percentCells.has(field.cell) || (field.format || "").includes("%");
  }

  function makeControl(field, compact = false) {
    let control;
    if (field.type === "select" || Array.isArray(field.options)) {
      control = node("select");
      const options = ["", ...(field.options || []).map(String).filter((option) => option !== "")];
      const current = String(state.inputs[field.cell] ?? "");
      if (!options.includes(current)) options.unshift(current);
      for (const value of options) {
        const option = node("option", "", value || "(blank)");
        option.value = value;
        control.append(option);
      }
      control.value = current;
    } else if (field.cell === "B12") {
      control = node("textarea");
      control.rows = 2;
      control.value = state.inputs[field.cell] ?? "";
    } else {
      control = node("input");
      control.type = field.type === "number" && field.cell !== "B28" ? "number" : "text";
      const value = state.inputs[field.cell] ?? "";
      control.value = state.inputDrafts.has(field.cell) ? state.inputDrafts.get(field.cell) : estimateControlValue(field, value);
      if (control.type === "number") {
        control.step = wholeCells.has(field.cell) ? "1" : "0.01";
        control.inputMode = wholeCells.has(field.cell) ? "numeric" : "decimal";
      }
      if (field.cell === "B28") control.inputMode = "decimal";
    }
    control.id = `input-${field.cell}`;
    control.dataset.cell = field.cell;
    control.setAttribute("aria-label", `${field.label || "Estimate input"}${isPercent(field) ? " in percent" : ""}`);
    if (state.inputErrors.has(field.cell)) {
      control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(state.inputErrors.get(field.cell));
    }
    control.addEventListener("input", () => {
      state.inputRevision++;
      let value = control.value;
      if (field.type === "number") value = editedEstimateNumber(control, field);
      if (field.type === "number" && typeof value === "string" && value !== "") {
        state.inputErrors.set(field.cell, `${field.label}: ${value}.`);
        state.inputDrafts.set(field.cell, control.value);
        control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(value);
        updateDirty(); scheduleCalculation(); return;
      }
      state.inputErrors.delete(field.cell); state.inputDrafts.delete(field.cell);
      control.removeAttribute("aria-invalid"); control.setCustomValidity?.("");
      state.inputs[field.cell] = value;
      updateDirty();
      scheduleCalculation();
    });
    if (field.type === "number") control.addEventListener("blur", () => {
      if (!state.inputErrors.has(field.cell) && (isNumber(state.inputs[field.cell]) || state.inputs[field.cell] === "")) control.value = estimateControlValue(field, state.inputs[field.cell]);
    });
    if (compact) return control;
    const label = node("label", "field");
    const caption = node("span", "", field.label || "Estimate input");
    if (isPercent(field) && !(field.label || "").includes("%")) caption.append(document.createTextNode(" (%)"));
    label.append(caption, control);
    return label;
  }

  function inputCard(title, fields, helper) {
    if (!fields.length) return null;
    const section = node("section", "card");
    const heading = node("div", "section-heading");
    const h2 = node("h2", "", title);
    h2.id = `section-${fields[0].cell}`;
    section.setAttribute("aria-labelledby", h2.id);
    heading.append(h2);
    const fieldGrid = node("div", "fields");
    for (const field of fields) fieldGrid.append(makeControl(field));
    section.append(heading, fieldGrid);
    if (helper) section.append(node("p", "helper", helper));
    return section;
  }

  function renderInputs() {
    const before = $("input-sections");
    const after = $("adjustment-sections");
    const materials = $("material-inputs");
    before.replaceChildren(); after.replaceChildren(); materials.replaceChildren();
    const job = [], labour = [], adjustments = [], additions = [], remainder = [];
    for (const field of state.fields) {
      // Keep historical workbook notes in the snapshot without a second editor.
      if (field.cell === "B12") continue;
      if (/^[BCDE](1[5-9]|2[0-3])$/.test(field.cell)) continue;
      if (/^B([2-9]|10)$/.test(field.cell)) job.push(field);
      else if (/^D[2-9]$/.test(field.cell) || field.cell === "D10") labour.push(field);
      else if (/^B2[6-8]$/.test(field.cell)) adjustments.push(field);
      else if (/^[EF]2[6-8]$/.test(field.cell)) additions.push({ ...field, label: additionLabels[field.cell] });
      else remainder.push(field);
    }
    for (const card of [inputCard("Job, access and travel", job), inputCard("Labour teams", labour)]) if (card) before.append(card);
    for (let row = 15; row <= 23; row++) {
      const tr = node("tr");
      const title = node("td", "material-label", materialNames[row - 15][0]);
      title.append(node("small", "", materialNames[row - 15][1]));
      tr.append(title);
      for (const col of ["B", "C", "D", "E"]) {
        const td = node("td");
        const field = fieldByCell(`${col}${row}`);
        td.append(field ? makeControl(field, true) : node("span", "", "—"));
        tr.append(td);
      }
      const yieldCell = node("td", "calculated-yield");
      const value = node("span", "", "—");
      value.id = `yield-${row}`;
      yieldCell.append(value);
      tr.append(yieldCell);
      materials.append(tr);
    }
    const additionCard = inputCard("Additional labour and fees", additions);
    additionCard?.querySelector(".fields").classList.add("two-columns");
    for (const card of [
      inputCard("Adjustments", adjustments, "Percentage inputs are shown as percentages: enter 10 for 10%. A negative global amount deducts from the quote."),
      additionCard,
      inputCard("Other estimate inputs", remainder),
    ]) if (card) after.append(card);
  }

  function clearResults(status) {
    $("calculation-status").textContent = status;
    document.querySelector(".summary-card").setAttribute("aria-busy", "true");
    for (const key of ["labour", "material", "access", "travel", "subtotal", "adjustment", "total", "rate", "days"]) $( `sum-${key}`).textContent = "—";
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = "—";
    $("calculated-notes").textContent = "—";
    const row = node("tr"); const cell = node("td", "", status === "Calculating…" ? "Calculating…" : "No current calculation is available.");
    cell.colSpan = 5; row.append(cell); $("material-results").replaceChildren(row);
    const labourRow = node("tr"), labourCell = node("td", "", status === "Calculating…" ? "Calculating…" : "No current calculation is available.");
    labourCell.colSpan = 2; labourRow.append(labourCell); $("labour-results").replaceChildren(labourRow);
    $("labour-breakdown").setAttribute("aria-busy", "true");
    $("calculation-errors").hidden = true;
    for (const control of document.querySelectorAll("[data-cell]")) control.removeAttribute("aria-invalid");
  }

  function scheduleCalculation() {
    state.revision++;
    state.result = null;
    clearTimeout(state.timer);
    if (state.controller) state.controller.abort();
    if (state.inputErrors.size) { showInputProblems(); return; }
    clearResults("Calculating…");
    state.timer = setTimeout(() => { calculate(); }, 180);
  }

  async function calculate() {
    clearTimeout(state.timer);
    const revision = ++state.revision;
    if (state.controller) state.controller.abort();
    if (state.inputErrors.size) { showInputProblems(); return null; }
    state.controller = new AbortController();
    clearResults("Calculating…");
    try {
      const result = await request("/api/calculate", {
        method: "POST", signal: state.controller.signal,
        body: JSON.stringify({ inputs: state.inputs, configuration: state.quoteConfiguration || state.configuration, workflow: state.workflow }),
      });
      if (revision !== state.revision) return null;
      state.result = result;
      renderResults(result);
      return result;
    } catch (error) {
      if (error.name === "AbortError" || revision !== state.revision) return null;
      clearResults("Calculation unavailable");
      $("labour-breakdown").setAttribute("aria-busy", "false");
      document.querySelector(".summary-card").setAttribute("aria-busy", "false");
      const box = $("calculation-errors");
      box.textContent = error.message;
      box.hidden = false;
      return null;
    }
  }

  function renderResults(result) {
    const summary = result.summary || {};
    const cells = result.cells || {};
    const errors = result.errors || {};
    for (const key of ["labour", "material", "access", "travel", "subtotal", "total", "rate"]) $(`sum-${key}`).textContent = formatMoney(summary[key]);
    $("sum-days").textContent = formatNumber(summary.days);
    $("sum-adjustment").textContent = formatMoney(cells.D27 ?? state.inputs.B28 ?? 0);
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = formatNumber(cells[`F${row}`]);
    $("calculated-notes").textContent = result.notes ?? cells.B30 ?? "";
    const materialRows = [];
    for (const material of result.materials || []) {
      const row = node("tr");
      row.append(node("td", "", material.name || "—"), node("td", "numeric", formatNumber(material.quantity)),
        node("td", "numeric", formatMoney(material.price)), node("td", "numeric", formatMoney(material.total)),
        node("td", "numeric", formatNumber(material.days)));
      materialRows.push(row);
    }
    if (!materialRows.length) { const row = node("tr"); const cell = node("td", "", "No material requirements."); cell.colSpan = 5; row.append(cell); materialRows.push(row); }
    $("material-results").replaceChildren(...materialRows);
    const labour = result.labour, labourRows = [];
    if (labour) {
      const addDays = (label, days, className = "") => {
        const row = node("tr", className), labelCell = node("th", "", label);
        labelCell.scope = "row"; row.append(labelCell, node("td", "numeric", formatNumber(days))); labourRows.push(row);
      };
      for (const task of labour.tasks || []) addDays(task.name, task.days);
      addDays("Task labour subtotal", labour.task_days, "labour-subtotal");
      addDays("Masking / cleaning", labour.masking_days);
      addDays("Extra labour", labour.extra_days);
      addDays("Mobilisation allowance", labour.mobilisation_days);
      addDays("Total project days", labour.total_days, "labour-total");
    } else {
      const row = node("tr"), cell = node("td", "", "Labour breakdown is unavailable for this result.");
      cell.colSpan = 2; row.append(cell); labourRows.push(row);
    }
    $("labour-results").replaceChildren(...labourRows);
    $("labour-breakdown").setAttribute("aria-busy", "false");
    const entries = Object.entries(errors);
    $("calculation-status").textContent = entries.length ? "Check errors" : "Calculated";
    document.querySelector(".summary-card").setAttribute("aria-busy", "false");
    const box = $("calculation-errors");
    box.replaceChildren();
    box.hidden = !entries.length;
    if (entries.length) {
      box.append(node("strong", "", "Some estimate calculations need attention."));
      const list = node("ul");
      const details = result.error_details || entries.map(([, code]) => ({ label: "Estimate calculation", code }));
      for (const error of details) list.append(node("li", "", `${error.label}: ${error.code}`));
      for (const [cell] of entries) $(`input-${cell}`)?.setAttribute("aria-invalid", "true");
      box.append(list);
    }
  }

  let confirmationQueue = Promise.resolve();

  function confirmReplace(title, detail, action) {
    // An import can finish while another confirmation is open. Each operation
    // needs its own answer; one click must never confirm two replacements.
    const answer = confirmationQueue.then(() => new Promise((resolve) => {
      const dialog = $("discard-dialog");
      dialog.querySelector("h2").textContent = title;
      dialog.querySelector("p").textContent = detail;
      dialog.querySelector('[value="confirm"]').textContent = action;
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    }));
    confirmationQueue = answer.catch(() => {});
    return answer;
  }

  async function newQuote() {
    if (state.dirty && !await confirmReplace("Start a new estimate?", "Your current unsaved estimate changes will be replaced with the default estimate inputs.", "Start new estimate")) return;
    state.quoteContext++;
    state.quoteLoadRevision++;
    state.inputErrors.clear(); state.inputDrafts.clear();
    state.quote = null; state.quoteConfiguration = null;
    state.fields = clone(state.currentFields);
    // Start notes blank without changing workbook defaults or saved-quote inputs.
    state.inputs = Object.fromEntries(state.fields.map((field) => [field.cell, field.cell === "B12" ? "" : field.default ?? ""]));
    state.legacyTitle = "";
    for (const id of ["client", "site-address", "project-no"]) $(id).value = "";
    updateQuoteTitle();
    state.workflow = state.defaultWorkflow;
    $("measurements").value = "";
    $("snapshot-message").hidden = true;
    renderInputs(); updateDirty(false); message(""); showView("estimate"); scheduleCalculation();
  }

  async function saveQuote() {
    if (inputProblem()) { message(inputProblem(), true); return; }
    updateQuoteTitle();
    const title = $("quote-title").value.trim();
    const button = $("save-quote"); button.disabled = true;
    try {
      const inputs = clone(state.inputs);
      const workflow = state.workflow;
      const measurements = $("measurements").value;
      const configuration = clone(state.quoteConfiguration || state.configuration);
      const quoteContext = state.quoteContext;
      const inputRevision = state.inputRevision;
      const details = quoteDetails();
      const payload = { title, inputs, workflow, measurements, configuration, ...details };
      const saved = await request(state.quote ? `/api/quotes/${encodeURIComponent(state.quote.id)}` : "/api/quotes", { method: state.quote ? "PUT" : "POST", body: JSON.stringify(payload) });
      if (quoteContext !== state.quoteContext) { message(`Saved “${title}”. Your currently open estimate has been kept.`); return; }
      const pricingChangedDuringSave = JSON.stringify(state.quoteConfiguration || state.configuration) !== JSON.stringify(configuration);
      state.quote = saved;
      if ([saved.project_no, saved.client, saved.site_address].some((value) => typeof value === "string" && value.trim())) state.legacyTitle = "";
      updateQuoteTitle();
      if (!pricingChangedDuringSave) state.quoteConfiguration = clone(saved.configuration || configuration);
      if (!pricingChangedDuringSave && saved.fields) { state.fields = clone(saved.fields); renderInputs(); }
      $("snapshot-message").hidden = false;
      if (!pricingChangedDuringSave) $("snapshot-message").querySelector("span").textContent = "This quote uses its saved pricing snapshot.";
      const changedDuringSave = pricingChangedDuringSave || state.inputRevision !== inputRevision || state.inputErrors.size > 0 || JSON.stringify(state.inputs) !== JSON.stringify(inputs) || JSON.stringify(quoteDetails()) !== JSON.stringify(details) || $("quote-title").value.trim() !== title || state.workflow !== workflow || $("measurements").value !== measurements;
      updateDirty(changedDuringSave);
      message(changedDuringSave ? `Saved “${title}”. Changes made while saving still need to be saved.` : `Saved “${title}” with its inputs and pricing snapshot.`);
    } catch (error) { message(`Quote was not saved. ${error.message}`, true); }
    finally { button.disabled = false; }
  }

  async function loadQuotes() {
    const list = $("quote-list"); list.textContent = "Loading saved quotes…";
    try {
      const data = await request("/api/quotes");
      if (!(data.quotes || []).length) { list.replaceChildren(node("p", "empty-state", "No saved quotes yet. Create an estimate and save it here.")); return; }
      list.replaceChildren(...data.quotes.map((quote) => {
        const item = node("article", "quote-item");
        const description = node("div");
        description.append(node("h3", "", quote.title || "Untitled quote"));
        const date = new Date(quote.updated_at);
        description.append(node("p", "", Number.isNaN(date.getTime()) ? "Saved locally" : `Updated ${date.toLocaleString("en-AU")}`));
        const button = node("button", "button secondary", "Open quote");
        button.type = "button";
        button.addEventListener("click", () => openQuote(quote.id, button));
        item.append(description, button); return item;
      }));
    } catch (error) { list.replaceChildren(node("p", "message error", error.message)); }
  }

  async function openQuote(id, button) {
    button.disabled = true;
    const loadRevision = ++state.quoteLoadRevision;
    try {
      const quote = await request(`/api/quotes/${encodeURIComponent(id)}`);
      if (loadRevision !== state.quoteLoadRevision) return;
      if (state.dirty && !await confirmReplace("Open this saved quote?", "Your current unsaved estimate changes will be replaced by the saved quote.", "Open saved quote")) return;
      if (loadRevision !== state.quoteLoadRevision) return;
      state.quoteContext++;
      state.inputErrors.clear(); state.inputDrafts.clear();
      state.quote = quote;
      state.quoteConfiguration = clone(quote.configuration || state.configuration);
      state.fields = clone(quote.fields || state.currentFields);
      state.inputs = { ...Object.fromEntries(state.fields.map((field) => [field.cell, field.default ?? ""])), ...quote.inputs };
      state.legacyTitle = [quote.project_no, quote.client, quote.site_address].some((value) => typeof value === "string" && value.trim()) ? "" : quote.title || "";
      $("client").value = quote.client || "";
      $("site-address").value = quote.site_address || "";
      $("project-no").value = quote.project_no || "";
      updateQuoteTitle();
      state.workflow = typeof quote.workflow === "string" ? quote.workflow : state.defaultWorkflow;
      $("measurements").value = typeof quote.measurements === "string" ? quote.measurements : JSON.stringify(quote.measurements || "");
      $("snapshot-message").hidden = false;
      $("snapshot-message").querySelector("span").textContent = "This quote uses its saved pricing snapshot.";
      renderInputs(); updateDirty(false); message(""); showView("estimate"); scheduleCalculation();
    } catch (error) { message(`Could not open the quote. ${error.message}`, true); }
    finally { button.disabled = false; }
  }

  function showView(view) {
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${view}`;
    for (const button of document.querySelectorAll("[data-view]")) {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    if (view === "quotes") loadQuotes();
    if (view === "pricing") renderPricing();
    if (view === "calculators") window.CeasefireCalculators?.open();
    // Each section starts with its heading and actions visible below the sticky
    // header, even when the previous estimate was scrolled far down the page.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  function getOverride(kind, id) { return state.draft[kind]?.[id] || {}; }

  function markPricingDirty() {
    state.pricingDirty = JSON.stringify(state.draft) !== JSON.stringify(state.configuration);
    $("pricing-status").textContent = state.pricingDirty ? "Unsaved pricing changes" : "Saved configuration";
  }

  function setOverride(kind, item, field, value) {
    state.draft[kind] ||= {};
    state.draft[kind][item.id] ||= {};
    const baseValue = kind === "rates" && field === "price" ? rateDefaultPrice(item) : item[field];
    if (value === "" || value === baseValue) delete state.draft[kind][item.id][field];
    else state.draft[kind][item.id][field] = value;
    if (!Object.keys(state.draft[kind][item.id]).length) delete state.draft[kind][item.id];
    markPricingDirty();
  }

  function priceInput(kind, item, key, options = {}) {
    const input = node("input", options.text ? "item-name" : "");
    input.type = options.text ? "text" : "number";
    input.step = "0.01";
    input.dataset.priceField = key;
    const current = getOverride(kind, item.id)[key] ?? options.defaultValue ?? item[key] ?? "";
    input.value = options.text ? current : controlValue(current, options.percent);
    input.setAttribute("aria-label", `${item.name}: ${options.label || key}${options.percent ? " in percent" : ""}`);
    input.addEventListener("input", () => {
      let value = input.value;
      if (!options.text) value = editedNumber(input, options.percent);
      setOverride(kind, item, key, value);
      const row = input.closest("tr");
      row.classList.toggle("edited", !!state.draft[kind][item.id]);
      const output = row.querySelector("[data-sell-preview]");
      if (output) output.textContent = formatMoney(inventorySellPrice(item));
      options.onChange?.();
    });
    if (!options.text) input.addEventListener("blur", () => {
      // Formatting the visible input does not add an override or round a rate.
      if (input.value !== "" && !input.validity.badInput && Number.isFinite(Number(input.value))) input.value = controlValue(Number(input.value));
    });
    return input;
  }

  function inventorySellPrice(item) {
    const override = getOverride("inventory", item.id);
    if (Object.hasOwn(override, "sales_price")) return override.sales_price;
    if (Object.hasOwn(override, "supplier_price") || Object.hasOwn(override, "markup")) {
      const supplier = override.supplier_price ?? item.supplier_price;
      return isNumber(supplier) ? supplier * (1 + (override.markup ?? item.markup ?? 0)) : item.sales_price;
    }
    return item.sales_price;
  }

  function rateSellPrice(item) {
    const override = getOverride("rates", item.id);
    if (Object.hasOwn(override, "price")) return override.price;
    return rateDefaultPrice(item);
  }

  function rateDefaultPrice(item) {
    const inventory = state.catalog.inventory.find((record) => record.id === item.inventory_id);
    const inventoryOverride = inventory ? getOverride("inventory", inventory.id) : {};
    if (item.price_mode !== "override" && inventory && ["supplier_price", "markup", "sales_price"].some((field) => Object.hasOwn(inventoryOverride, field))) return inventorySellPrice(inventory);
    return item.price;
  }

  function refreshPricingCatalog() {
    state.catalog = clone(state.draft.catalog || state.baseline);
    const selection = $("rate-group").value;
    const options = [["", "All uses"], ...Object.keys(state.catalog.rate_groups || {}).map((key) => [key, groups[key] || key]), ["not-used", "Not used"]].map(([key, label]) => {
      const option = node("option", "", label); option.value = key; return option;
    });
    $("rate-group").replaceChildren(...options);
    $("rate-group").value = options.some((option) => option.value === selection) ? selection : "";
  }

  function resetButton(kind, item) {
    const button = node("button", "reset-button", "Reset row");
    button.type = "button";
    button.setAttribute("aria-label", `Restore imported values for ${item.name}`);
    button.addEventListener("click", () => { delete state.draft[kind][item.id]; markPricingDirty(); renderPricing(); });
    return button;
  }

  function renderPricing() {
    const search = $("pricing-search").value.trim().toLocaleLowerCase();
    const selectedGroup = $("rate-group").value;
    const records = (state.catalog.inventory || []).map((item) => ({ kind: "inventory", item, uses: [], key: `inventory:${item.id}` }));
    const products = new Map(records.map((record) => [record.item.id, record]));
    for (const [group, rates] of Object.entries(state.catalog.rate_groups || {})) for (const item of rates) {
      const use = { group, item }, product = products.get(item.inventory_id);
      if (product) product.uses.push(use);
      else records.push({ kind: "rates", item, uses: [use], key: `rates:${item.id}` });
    }
    const productText = ({ kind, item }) => `${item.name} ${item.item_code || ""} ${getOverride(kind, item.id).name || ""}`.toLocaleLowerCase();
    const matches = records.filter((record) => {
      const groupMatch = !selectedGroup || (selectedGroup === "not-used" ? !record.uses.length : record.uses.some((use) => use.group === selectedGroup));
      const useText = record.uses.map(({ group, item }) => `${groups[group] || group} ${item.name} ${item.display_name || ""}`).join(" ").toLocaleLowerCase();
      return groupMatch && `${productText(record)} ${useText}`.includes(search);
    });
    $("pricing-count").textContent = `${matches.length} of ${records.length} products and standalone rates`;
    $("pricing-help").textContent = "Supplier price and markup calculate the product sell price. Expand Used in to edit each estimator rate or material yield. Reset rate restores its imported price source; Reset yield restores imported coverage.";
    const heading = node("tr");
    for (const title of ["Item code", "Product / standalone rate", "Supplier price", "Markup %", "Sell price", ""]) heading.append(node("th", "", title));
    $("pricing-head").replaceChildren(heading);
    const refreshers = [], refreshPrices = () => refreshers.forEach((refresh) => refresh());
    const resetRateField = (item, field, label, groupLabel) => {
      const button = node("button", "reset-button", label); button.type = "button";
      button.setAttribute("aria-label", `${item.name}: ${groupLabel} ${label.toLowerCase()}`);
      refreshers.push(() => { button.disabled = !Object.hasOwn(getOverride("rates", item.id), field); });
      button.addEventListener("click", () => {
        const patch = state.draft.rates?.[item.id];
        if (patch) { delete patch[field]; if (!Object.keys(patch).length) delete state.draft.rates[item.id]; }
        markPricingDirty(); renderPricing();
      });
      return button;
    };
    const rows = [];
    for (const record of matches) {
      const { item, kind, uses } = record, inventoryView = kind === "inventory";
      const row = node("tr", state.draft[kind]?.[item.id] ? "edited" : "");
      row.dataset.priceId = item.id; row.dataset.priceKind = kind;
      row.append(node("td", "", inventoryView ? item.item_code || "—" : "—"));
      const nameCell = node("td");
      if (inventoryView) nameCell.append(priceInput(kind, item, "name", { text: true, label: "Name" }));
      else nameCell.append(node("span", "", item.name));
      const detail = inventoryView ? (item.pricing_mode === "manual" ? "Manual sell price" : "Supplier price and markup") : "Standalone rate · no inventory link";
      nameCell.append(node("small", "subtext", detail));
      if (!uses.length) nameCell.append(node("small", "subtext", "Not used in Estimator"));
      row.append(nameCell);
      if (inventoryView) {
        const supplier = node("td");
        const markup = node("td");
        if (item.pricing_mode === "manual") {
          supplier.textContent = formatMoney(item.supplier_price);
          markup.textContent = "—";
        } else {
          supplier.append(priceInput(kind, item, "supplier_price", { label: "Supplier price", onChange: refreshPrices }));
          markup.append(priceInput(kind, item, "markup", { percent: true, label: "Markup", onChange: refreshPrices }));
        }
        const sell = node("td");
        if (item.pricing_mode === "manual") sell.append(priceInput(kind, item, "sales_price", { label: "Manual sell price", onChange: refreshPrices }));
        else { const output = node("span", "price-value", formatMoney(inventorySellPrice(item))); output.dataset.sellPreview = "true"; sell.append(output); }
        row.append(supplier, markup, sell);
      } else {
        const price = node("span", "price-value"); refreshers.push(() => { price.textContent = formatMoney(rateSellPrice(item)); });
        const sell = node("td"); sell.append(price); row.append(node("td", "", "—"), node("td", "", "—"), sell);
      }
      const reset = node("td"); reset.append(resetButton(kind, item)); row.append(reset);
      rows.push(row);
      if (!uses.length) continue;
      const detailRow = node("tr", "pricing-use-row"), detailCell = node("td"), details = node("details", "pricing-uses");
      detailCell.colSpan = 6; detailRow.dataset.pricingUsesFor = record.key;
      const groupNames = [...new Set(uses.map(({ group }) => groups[group] || group))].join(", ");
      details.append(node("summary", "", `Used in: ${groupNames} · ${uses.length} ${uses.length === 1 ? "selection" : "selections"}`));
      details.open = state.pricingExpanded.has(record.key) || Boolean(search && !productText(record).includes(search));
      details.addEventListener("toggle", () => { if (details.open) state.pricingExpanded.add(record.key); else state.pricingExpanded.delete(record.key); });
      const scroll = node("div", "pricing-uses-scroll"), table = node("table", "pricing-uses-table"), head = node("thead"), titles = node("tr"), body = node("tbody");
      table.setAttribute("aria-label", `Estimator uses for ${getOverride(kind, item.id).name || item.name}`);
      for (const title of ["Used in Estimator", "Selection name", "Sell rate", "Price source", "Yield", ""]) { const cell = node("th", "", title); cell.scope = "col"; titles.append(cell); }
      head.append(titles);
      for (const { group, item: rate } of uses) {
        const groupLabel = groups[group] || group;
        const useRow = node("tr", state.draft.rates?.[rate.id] ? "edited" : ""); useRow.dataset.rateId = rate.id; useRow.dataset.rateGroup = group;
        const price = node("td"), input = priceInput("rates", rate, "price", { label: `${groupLabel} sell rate`, defaultValue: rateSellPrice(rate), onChange: refreshPrices }); price.append(input);
        const status = node("td", "pricing-rate-source");
        refreshers.push(() => {
          if (input !== document.activeElement) input.value = controlValue(rateSellPrice(rate));
          status.textContent = Object.hasOwn(getOverride("rates", rate.id), "price") ? "Rate override" : !inventoryView ? "Standalone rate" : rate.price_mode === "override" ? "Imported rate override" : "Follows inventory pricing";
        });
        const yieldCell = node("td"), actions = node("td", "pricing-rate-actions");
        actions.append(resetRateField(rate, "price", "Reset rate", groupLabel));
        if (rate.uses_yield ?? !!rate.source?.yield) {
          yieldCell.append(priceInput("rates", rate, "yield", { label: `${groupLabel} material yield`, onChange: refreshPrices }));
          actions.append(resetRateField(rate, "yield", "Reset yield", groupLabel));
        } else yieldCell.textContent = "—";
        useRow.append(node("td", "", groups[group] || group), node("td", "", rate.name), price, status, yieldCell, actions); body.append(useRow);
      }
      table.append(head, body); scroll.append(table); details.append(scroll); detailCell.append(details); detailRow.append(detailCell); rows.push(detailRow);
    }
    if (!rows.length) { const row = node("tr"); const cell = node("td", "empty-state", "No matching products or rates."); cell.colSpan = 6; row.append(cell); rows.push(row); }
    $("pricing-body").replaceChildren(...rows);
    refreshPrices();
    markPricingDirty();
  }

  async function savePricing() {
    const button = $("save-pricing"); button.disabled = true;
    $("use-current-pricing").disabled = true;
    let persisted = false;
    try {
      const draft = clone(state.draft);
      const configuration = await request("/api/configuration", { method: "PUT", body: JSON.stringify(draft) });
      persisted = true;
      const metadata = await request("/api/bootstrap");
      // Keep prices and their dropdown definitions in step. Until both arrive,
      // estimates continue using the previously loaded pricing configuration.
      state.configuration = clone(metadata.configuration || configuration);
      state.currentFields = clone(metadata.fields || state.currentFields);
      if (JSON.stringify(state.draft) === JSON.stringify(draft)) state.draft = clone(state.configuration);
      refreshPricingCatalog();
      renderPricing();
      if (!state.quoteConfiguration) { state.fields = clone(state.currentFields); renderInputs(); updateDirty(); scheduleCalculation(); }
      const changedElsewhere = JSON.stringify(state.configuration) !== JSON.stringify(configuration);
      message(changedElsewhere ? "Pricing was saved, then changed in another session. The latest saved library is loaded; any further draft edits are still unsaved."
        : state.pricingDirty ? "Pricing saved. Changes made while saving are still unsaved." : "Pricing library saved. The saved products, choices and rates now apply to new estimates.");
    } catch (error) { message(persisted ? `Pricing was saved, but the updated dropdowns could not be loaded. Reload the app before starting another estimate. ${error.message}` : `Pricing was not saved. ${error.message}`, true); }
    finally { button.disabled = false; $("use-current-pricing").disabled = false; }
  }

  function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url; link.download = filename; link.hidden = true;
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
  }

  async function exportPricing() {
    const button = $("export-pricing");
    if (button.disabled) return;
    const draft = JSON.stringify(state.draft);
    button.disabled = true; button.textContent = "Exporting…";
    try {
      const response = await fetch("/api/pricing/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configuration: JSON.parse(draft) }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || `Export failed (${response.status}).`);
      }
      const contentType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") throw new Error("The server did not return an Excel workbook.");
      const workbook = await response.blob();
      if (!workbook.size) throw new Error("The server returned an empty workbook.");
      downloadFile(workbook, "ceasefire-pricing.xlsx");
      message(draft === JSON.stringify(state.draft)
        ? "Excel download started. It includes all inventory and rate groups, including your unsaved pricing edits."
        : "Excel download started using the pricing captured when you clicked Export Excel. Later edits are not included.");
    } catch (error) { message(`Pricing was not exported. ${error.message}`, true); }
    finally { button.disabled = false; button.textContent = "Export Excel"; }
  }

  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("The selected file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function importPricing() {
    const input = $("pricing-import-file");
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const button = $("import-pricing");
    const draft = JSON.stringify(state.draft);
    button.disabled = true; button.textContent = "Reading Excel…";
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an .xlsx workbook exported from this pricing library.");
      if (file.size > 5 * 1024 * 1024) throw new Error("The workbook must be 5 MB or smaller.");
      const content = await fileBase64(file);
      const preview = await request("/api/pricing/import", {
        method: "POST", body: JSON.stringify({ filename: file.name, content_base64: content, configuration: JSON.parse(draft) }),
      });
      if (draft !== JSON.stringify(state.draft)) throw new Error("Pricing changed while the workbook was being read. Import it again to compare against your latest edits.");
      const counts = (kind, label) => {
        const count = preview.summary?.[kind] || {};
        return `${label}: ${count.added || 0} added, ${count.removed || 0} removed, ${count.updated || 0} updated.`;
      };
      const detail = `${file.name}\n${counts("inventory", "Inventory")}\n${counts("rates", "Rates and choices")}\nThis replaces the entire draft library. Deleted workbook rows will be removed. The changes take effect only after you click Save pricing.`;
      const accepted = await confirmReplace("Review imported pricing", detail, "Apply to draft");
      if (!accepted) { message("Import cancelled. Your pricing draft was kept."); return; }
      if (draft !== JSON.stringify(state.draft)) throw new Error("Pricing changed during import review. Import again to keep your latest edits safe.");
      state.draft = clone(preview.configuration);
      refreshPricingCatalog(); renderPricing();
      message("Imported pricing is ready to review. Click Save pricing to apply the new products, dropdown choices and rates.");
    } catch (error) { message(`Pricing was not imported. ${error.message}`, true); }
    finally { button.disabled = false; button.textContent = "Import Excel"; }
  }

  async function bootstrap() {
    try {
      const data = await request("/api/bootstrap");
      state.currentFields = clone(data.fields || []);
      state.fields = clone(state.currentFields);
      state.baseline = data.baseline || { inventory: [], rate_groups: {} };
      state.configuration = data.configuration || { inventory: {}, rates: {} };
      state.draft = clone(state.configuration);
      if (Array.isArray(data.workflows) && data.workflows.length) {
        state.defaultWorkflow = data.workflows[0];
      }
      refreshPricingCatalog();
      $("loading-state").hidden = true;
      await newQuote();
      $("project-tools").hidden = false;
    } catch (error) { $("loading-state").textContent = "The estimator could not be loaded. Reload after the local server is available."; message(error.message, true); }
  }

  function reportPayload() {
    updateQuoteTitle();
    return {
      title: $("quote-title").value.trim(),
      ...quoteDetails(),
      inputs: clone(state.inputs),
      configuration: clone(state.quoteConfiguration || state.configuration),
      workflow: state.workflow,
      measurements: $("measurements").value,
      ...(state.quote ? { source_quote_id: state.quote.id } : {}),
    };
  }

  function reportFilename(disposition) {
    const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition || "");
    const filename = (match?.[1] ?? match?.[2] ?? "").trim();
    // Accept only safe ASCII filenames; ignore paths or unexpected values.
    return /^[a-z0-9][a-z0-9._-]{0,180}\.pdf$/i.test(filename) ? filename : "CEASEFIRE-Estimate.pdf";
  }

  function projectEstimate() {
    const payload = reportPayload(); delete payload.source_quote_id; return payload;
  }

  function projectStamp() {
    return JSON.stringify({ estimate: projectEstimate(), quoteContext: state.quoteContext,
      quoteLoadRevision: state.quoteLoadRevision, inputRevision: state.inputRevision,
      errors: [...state.inputErrors], inputDrafts: [...state.inputDrafts],
      calculators: window.CeasefireCalculators.projectFingerprint() });
  }

  function projectBusy(value) {
    state.projectBusy = value;
    for (const id of ["save-project", "load-project"]) { $(id).disabled = value; $(id).setAttribute("aria-busy", String(value)); }
  }

  async function saveProject() {
    if (state.projectBusy) return;
    projectBusy(true);
    try {
      if (inputProblem()) throw new Error(inputProblem());
      const payload = { estimate: projectEstimate(), calculators: window.CeasefireCalculators.projectSnapshot() };
      const captured = projectStamp();
      const response = await fetch("/api/project/export", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/octet-stream" }, body: JSON.stringify(payload) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || "The project file could not be created."); }
      if ((response.headers.get("Content-Type") || "").split(";")[0].trim() !== "application/octet-stream") throw new Error("The server did not return a project file.");
      const blob = await response.blob(); if (!blob.size) throw new Error("The project file is empty.");
      downloadFile(blob, "CEASEFIRE-Project.ceasefire-project.json");
      const changed = captured !== projectStamp();
      message(`Project file download started. It includes the estimate, its pricing snapshot and all three calculators.${changed ? " Later edits are not included." : ""}`);
    } catch (error) { message(`Project was not saved. ${error.message}`, true); }
    finally { projectBusy(false); }
  }

  async function loadProject() {
    const input = $("project-import-file"), file = input.files?.[0]; input.value = "";
    if (!file || state.projectBusy) return;
    projectBusy(true);
    try {
      if (!/\.json$/i.test(file.name) || !file.size || file.size > 16 * 1024 * 1024) throw new Error("Choose a project JSON file up to 16 MB.");
      const captured = projectStamp();
      const content_base64 = await fileBase64(file);
      const project = await request("/api/project/import", { method: "POST", body: JSON.stringify({ filename: file.name, content_base64 }) });
      const prepared = await window.CeasefireCalculators.prepareProject(project.calculators);
      if (captured !== projectStamp()) throw new Error("Your draft changed while reading the file. Load it again when ready.");
      const detail = project.project_details || {};
      const accepted = await confirmReplace("Load this project?", `${file.name}\nProject No.: ${detail.project_no || "Not recorded"}\nClient: ${detail.client || "Not recorded"}\nSite Address: ${detail.site_address || "Not recorded"}\n\nThis replaces the current estimate and all three calculator drafts. Saved quotes and the pricing library stay unchanged.`, "Load Project");
      if (!accepted) { message("Project load cancelled. Your current drafts were kept."); return; }
      if (captured !== projectStamp()) throw new Error("Your draft changed during review. Load the file again to keep your latest edits safe.");
      const estimate = project.estimate;
      // All validation and definition loading finish before either workspace changes.
      const inputs = clone(estimate.inputs), configuration = clone(estimate.configuration), fields = clone(project.fields);
      window.CeasefireCalculators.applyProject(prepared);
      ++state.quoteContext; ++state.quoteLoadRevision;
      state.inputErrors.clear(); state.inputDrafts.clear();
      state.quote = null; state.quoteConfiguration = configuration; state.fields = fields; state.inputs = inputs;
      state.legacyTitle = [estimate.project_no, estimate.client, estimate.site_address].some(Boolean) ? "" : estimate.title || "";
      $("project-no").value = estimate.project_no || ""; $("client").value = estimate.client || ""; $("site-address").value = estimate.site_address || "";
      state.workflow = estimate.workflow; $("measurements").value = estimate.measurements || "";
      updateQuoteTitle(); renderInputs(); updateDirty();
      $("snapshot-message").hidden = false; $("snapshot-message").querySelector("span").textContent = "This project uses the pricing snapshot from its file.";
      showView("estimate"); scheduleCalculation();
      message("Project loaded as a draft. Save Project downloads a complete copy; Save quote and Save calculator keep individual records on this computer.");
    } catch (error) { message(`Project was not loaded. ${error.message}`, true); }
    finally { projectBusy(false); }
  }

  async function downloadQuotePdf() {
    if (inputProblem()) { message(inputProblem(), true); return; }
    const button = $("download-quote-pdf");
    if (button.disabled) return;
    const payload = reportPayload();
    const quoteContext = state.quoteContext;
    const capturedPayload = JSON.stringify(payload);
    const savedReportId = state.quote && !state.dirty ? state.quote.id : null;
    const reportPath = savedReportId ? `/api/quotes/${encodeURIComponent(savedReportId)}/report.pdf` : "/api/quote-report";
    const reportOptions = savedReportId
      ? { method: "GET", headers: { "Accept": "application/pdf" } }
      : { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/pdf" }, body: capturedPayload };
    button.disabled = true;
    button.textContent = "Preparing PDF…";
    button.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(reportPath, reportOptions);
      const contentType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok) {
        let detail = `The server could not create the PDF (${response.status}).`;
        if (contentType === "application/json") {
          const data = await response.json().catch(() => null);
          if (typeof data?.error === "string") detail = data.error;
          else if (typeof data?.message === "string") detail = data.message;
        }
        throw new Error(detail);
      }
      if (contentType !== "application/pdf") throw new Error("The server returned an unexpected file type instead of a PDF.");
      const pdf = await response.blob();
      if (!pdf.size) throw new Error("The server returned an empty PDF.");
      const url = URL.createObjectURL(pdf);
      const link = node("a");
      link.href = url;
      link.download = reportFilename(response.headers.get("Content-Disposition"));
      link.hidden = true;
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        // Allow the browser to begin reading the blob before releasing it.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      const estimateChanged = quoteContext !== state.quoteContext || capturedPayload !== JSON.stringify(reportPayload());
      message(estimateChanged
        ? `PDF download started for “${payload.title}” using ${savedReportId ? "its saved result and pricing snapshot" : "the inputs and pricing captured when you clicked Download PDF"}. Later edits are not included.`
        : `PDF download started for “${payload.title}”.`);
    } catch (error) { message(`PDF for “${payload.title}” was not downloaded. ${error.message}`, true); }
    finally {
      button.disabled = false;
      button.textContent = "Download PDF";
      button.removeAttribute("aria-busy");
    }
  }

  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => showView(button.dataset.view));
  for (const id of ["client", "site-address", "project-no"]) $(id).addEventListener("input", () => { updateQuoteTitle(); updateDirty(); });
  $("measurements").addEventListener("input", () => updateDirty());
  $("new-quote").addEventListener("click", newQuote);
  $("save-quote").addEventListener("click", saveQuote);
  $("download-quote-pdf").addEventListener("click", downloadQuotePdf);
  $("save-project").addEventListener("click", saveProject);
  $("load-project").addEventListener("click", () => { if (!state.projectBusy) $("project-import-file").click(); });
  $("project-import-file").addEventListener("change", loadProject);
  $("edit-project-details").addEventListener("click", () => { showView("estimate"); $("project-no").focus(); });
  $("refresh-quotes").addEventListener("click", loadQuotes);
  $("use-current-pricing").addEventListener("click", () => { state.quoteConfiguration = clone(state.configuration); state.fields = clone(state.currentFields); renderInputs(); $("snapshot-message").querySelector("span").textContent = "Current pricing applied. Save to replace this quote's pricing snapshot."; updateDirty(); scheduleCalculation(); message("Current pricing applied to this estimate. Check any removed product selections, then save the quote to retain its new pricing snapshot."); });
  $("pricing-search").addEventListener("input", renderPricing);
  $("rate-group").addEventListener("change", renderPricing);
  $("save-pricing").addEventListener("click", savePricing);
  $("export-pricing").addEventListener("click", exportPricing);
  $("import-pricing").addEventListener("click", () => $("pricing-import-file").click());
  $("pricing-import-file").addEventListener("change", importPricing);
  $("discard-pricing").addEventListener("click", async () => {
    if (state.pricingDirty && !await confirmReplace("Discard pricing changes?", "Unsaved pricing edits will be replaced with your last saved configuration.", "Discard changes")) return;
    state.draft = clone(state.configuration); refreshPricingCatalog(); renderPricing(); message("Unsaved pricing changes discarded.");
  });
  window.addEventListener("beforeunload", (event) => { if (state.dirty || state.pricingDirty) { event.preventDefault(); event.returnValue = ""; } });
  window.CeasefireProject = { details: quoteDetails };
  bootstrap();
})();
