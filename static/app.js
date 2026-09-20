"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    fields: [], currentFields: [], inputs: {}, catalog: { inventory: [], rate_groups: {} }, baseline: { inventory: [], rate_groups: {} },
    configuration: { inventory: {}, rates: {} }, draft: { inventory: {}, rates: {} },
    quote: null, quoteConfiguration: null, quoteContext: 0, quoteLoadRevision: 0, dirty: false, pricingDirty: false,
    result: null, revision: 0, timer: null, controller: null, pricingExpanded: new Set(), legacyTitle: "",
    workflow: "", defaultWorkflow: "Intumescent spray to ductwork", inputErrors: new Map(), inputDrafts: new Map(), inputRevision: 0, projectBusy: false,
    pricingScope: "library", libraryDraft: null, projectPricingDraft: null, pricingRevision: 0,
    projectFile: null, projectsRevision: 0, initialized: false, currentView: "home", projectsOffset: 0, projectsTimer: null,
    pricingRender: null, estimatorKind: "estimate", libraryKind: "pricing",
  };
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const quantity = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percentCells = new Set(["B9", "B26", "B27", ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const wholeCells = new Set(["B4", "B8", "B9", "B26", "B27", "F27", "F28", ...Array.from({ length: 9 }, (_, i) => `B${i + 15}`), ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const materialNames = [
    ["Spraying", "Bags / drums / rolls"], ["Meshing", "m²"], ["Pins / clips", "m²"],
    ["Access panels", "Number of panels"], ["PromaMesh / fan enclosures", "m²"],
    ["Primer", "m²"], ["Topcoat", "m²"], ["Board", "m²"], ["Mastic", "Linear metres"],
  ];
  const coverageTeams = { B15: "D2", B16: "D3", B18: "D6", B19: "D8", B20: "D4", B21: "D5", B22: "D9", B23: "D10" };
  const materialTeams = { 15: "D2", 16: "D3", 17: "D3", 18: "D6", 19: "D8", 20: "D4", 21: "D5", 22: "D9", 23: "D10" };
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

  function coverageNeedsTeam(cell) {
    const team = coverageTeams[cell]; if (!team) return false;
    const value = Object.hasOwn(state.inputs, team) ? state.inputs[team] : fieldByCell(team)?.default;
    return value === null || value === "" || typeof value === "string" && value.toLowerCase() === "n/a";
  }

  function validateCoverageTeams() {
    for (const cell of Object.keys(coverageTeams)) {
      const value = Object.hasOwn(state.inputs, cell) ? state.inputs[cell] : fieldByCell(cell)?.default;
      const blocked = isNumber(value) && value !== 0 && coverageNeedsTeam(cell);
      if (blocked && !state.inputDrafts.has(cell)) state.inputErrors.set(cell, "Select Teams");
      else if (!blocked && state.inputErrors.get(cell) === "Select Teams") state.inputErrors.delete(cell);
      const control = $(`input-${cell}`), error = state.inputErrors.get(cell);
      if (error) control?.setAttribute("aria-invalid", "true"); else control?.removeAttribute("aria-invalid");
      control?.setCustomValidity?.(error || "");
    }
  }

  function updateMaterialRowVisibility() {
    for (const row of $("material-inputs").children) {
      const team = materialTeams[Number(row.dataset.materialRow)];
      const value = Object.hasOwn(state.inputs, team) ? state.inputs[team] : fieldByCell(team)?.default;
      row.hidden = typeof value === "string" && value.trim().toLowerCase() === "n/a";
    }
  }

  function inputProblem() { validateCoverageTeams(); return [...state.inputErrors.values()][0] || window.CeasefirePenetrations?.scheduleProblem?.() || ""; }

  function showInputProblems() {
    clearResults("Check inputs");
    const box = $("calculation-errors"); box.textContent = [...state.inputErrors.values(), window.CeasefirePenetrations?.scheduleProblem?.()].filter(Boolean).join("\n"); box.hidden = false;
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
    $("quote-status").textContent = `${state.projectFile ? "Project file" : state.quote ? "Older saved estimate" : "New project"}${value ? " · Unsaved changes" : ""}`;
    updateProjectStatus();
  }

  function updateProjectStatus() {
    const file = state.projectFile, changed = !!projectHasChanges();
    const status = $("project-save-state");
    status.textContent = state.projectBusy ? "Working…" : changed ? "Unsaved changes" : file ? "Saved project" : "Not saved to a file";
    status.classList.toggle("unsaved", changed || !file);
    $("project-file-location").textContent = file?.path || file?.relative_path || (file ? "Imported file · choose a folder with Save As" : "Choose a folder with Save As");
    const savedAt = file?.modified_at ? new Date(file.modified_at) : null;
    $("project-last-saved").textContent = savedAt && !Number.isNaN(savedAt.getTime()) ? `File saved ${savedAt.toLocaleString("en-AU")}` : "File save time unavailable";
    $("project-last-saved").hidden = !file;
    $("project-pricing-source").textContent = state.quoteConfiguration ? "Pricing: project snapshot" : "Pricing: current saved library";
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
        const label = Object.hasOwn(field.option_labels || {}, value) ? field.option_labels[value] : value;
        const option = node("option", "", value ? label : "(blank)");
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
      if (coverageNeedsTeam(field.cell) && value !== "" && Number.isFinite(Number(value)) && Number(value) !== 0) {
        control.value = state.inputDrafts.has(field.cell) ? state.inputDrafts.get(field.cell) : estimateControlValue(field, state.inputs[field.cell]);
        validateCoverageTeams(); message("Select Teams", true);
        if (state.inputErrors.size) showInputProblems();
        return;
      }
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
      validateCoverageTeams();
      if (Object.values(materialTeams).includes(field.cell)) updateMaterialRowVisibility();
      if (state.inputErrors.get(Object.keys(coverageTeams).find(cell => coverageTeams[cell] === field.cell)) === "Select Teams") message("Select Teams", true);
      else if ($("app-message").textContent === "Select Teams" && ![...state.inputErrors.values()].includes("Select Teams")) message("");
      updateDirty();
      if (field.cell === "D7") renderInputs();
      scheduleCalculation();
    });
    if (field.type === "number") control.addEventListener("blur", () => {
      if (!state.inputErrors.has(field.cell) && (isNumber(state.inputs[field.cell]) || state.inputs[field.cell] === "")) control.value = estimateControlValue(field, state.inputs[field.cell]);
    });
    if (compact) return control;
    const label = node("label", "field");
    const caption = node("span", "", field.label || "Estimate input");
    if (field.cell === "B9") {
      const help = "Masking/cleaning is a percentage of Spray labour.";
      caption.title = help; control.title = help; control.setAttribute("aria-description", help);
    }
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
    const postMaterials = $("post-material-input-sections");
    const after = $("adjustment-sections");
    const materials = $("material-inputs");
    const project = $("project-input-fields");
    before.replaceChildren(); postMaterials.replaceChildren(); after.replaceChildren(); materials.replaceChildren(); project.replaceChildren();
    const job = [], labour = [], masking = [], adjustments = [], additions = [], remainder = [];
    for (const field of state.fields) {
      // Keep historical workbook notes in the snapshot without a second editor.
      if (field.cell === "B12") continue;
      if (/^[BCDE](1[5-9]|2[0-3])$/.test(field.cell)) continue;
      if (field.cell === "B8") project.append(makeControl(field));
      else if (field.cell === "B9" || field.cell === "B10") masking.push(field);
      else if (/^B[2-7]$/.test(field.cell)) job.push(field);
      else if (/^D[2-9]$/.test(field.cell) || field.cell === "D10") labour.push(field);
      else if (/^B2[6-8]$/.test(field.cell)) adjustments.push(field);
      else if (/^[EF]2[6-8]$/.test(field.cell)) additions.push({ ...field, label: additionLabels[field.cell] });
      else remainder.push(field);
    }
    const maskingActive = String(state.inputs.D7 ?? "").trim().toLowerCase() !== "n/a";
    for (const card of [inputCard("Access & Travel", job), inputCard("Teams/Crews", labour)]) if (card) before.append(card);
    const maskingCard = maskingActive ? inputCard("Masking/Cleaning", masking) : null;
    if (maskingCard) postMaterials.append(maskingCard);
    for (let row = 15; row <= 23; row++) {
      const tr = node("tr");
      tr.dataset.materialRow = String(row);
      const title = node("td", "material-label", materialNames[row - 15][0]);
      title.append(node("small", "", materialNames[row - 15][1]));
      tr.append(title);
      for (const col of ["B", "C", "D", "E"]) {
        const td = node("td");
        const field = fieldByCell(`${col}${row}`);
        const control = field ? makeControl(field, true) : node("span", "", "—");
        if (field && (col === "B" || col === "C")) {
          const unit = col === "B" ? materialNames[row - 15][1] : row === 17 ? "m²" : "Quantity";
          control.title = unit;
          control.setAttribute("aria-label", `${materialNames[row - 15][0]} — ${col === "B" ? "Coverage required" : "Daily output"} (${unit})`);
          if (col === "C") control.setAttribute("aria-description", row === 17
            ? "Square metres per day. This field does not change pinning labour, which follows meshing days."
            : "Quantity of selected product units completed per day.");
        }
        td.append(control);
        tr.append(td);
      }
      const yieldCell = node("td", "calculated-yield");
      const value = node("span", "", "—");
      value.id = `yield-${row}`;
      yieldCell.append(value);
      tr.append(yieldCell);
      materials.append(tr);
    }
    updateMaterialRowVisibility();
    const additionCard = inputCard("Additions", additions);
    additionCard?.querySelector(".fields").classList.add("two-columns");
    for (const card of [
      inputCard("Global Adjustments", adjustments, "Percentage inputs are shown as percentages: enter 10 for 10%. A negative global amount deducts from the quote."),
      additionCard,
      inputCard("Other estimate inputs", remainder),
    ]) if (card) after.append(card);
    validateCoverageTeams();
    if ([...state.inputErrors.values()].includes("Select Teams")) showInputProblems();
  }

  function clearResults(status) {
    $("calculation-status").textContent = status;
    document.querySelector(".summary-card").setAttribute("aria-busy", "true");
    for (const key of ["labour", "material", "access", "travel", "material-adjustment", "labour-adjustment", "subtotal", "adjustment", "total", "rate", "days"]) $( `sum-${key}`).textContent = "—";
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = "—";
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
    if (inputProblem()) { showInputProblems(); return; }
    clearResults("Calculating…");
    state.timer = setTimeout(() => { calculate(); }, 180);
  }

  async function calculate() {
    clearTimeout(state.timer);
    const revision = ++state.revision;
    if (state.controller) state.controller.abort();
    if (inputProblem()) { showInputProblems(); return null; }
    state.controller = new AbortController();
    clearResults("Calculating…");
    try {
      const result = await request("/api/calculate", {
        method: "POST", signal: state.controller.signal,
        body: JSON.stringify({ inputs: state.inputs, configuration: state.quoteConfiguration || state.configuration, workflow: state.workflow, ...(window.CeasefirePenetrations?.quoteSnapshot?.() ? { penetration: window.CeasefirePenetrations.quoteSnapshot() } : {}) }),
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
    $("sum-material-adjustment").textContent = formatMoney(result.global_adjustments?.material?.amount);
    $("sum-labour-adjustment").textContent = formatMoney(result.global_adjustments?.labour?.amount);
    $("sum-adjustment").textContent = formatMoney(cells.D27 ?? state.inputs.B28 ?? 0);
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = formatNumber(cells[`F${row}`]);
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
      for (const task of labour.tasks || []) if (task.source !== "firestopping") addDays(task.name, task.days);
      if ((labour.tasks || []).some(task => task.source === "firestopping")) addDays("Firestopping", labour.firestopping_days);
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

  function confirmReplace(title, detail, action, cancel = "Keep editing") {
    // An import can finish while another confirmation is open. Each operation
    // needs its own answer; one click must never confirm two replacements.
    const answer = confirmationQueue.then(() => new Promise((resolve) => {
      const dialog = $("discard-dialog");
      dialog.querySelector("h2").textContent = title;
      dialog.querySelector("p").textContent = detail;
      dialog.querySelector('[value="cancel"]').textContent = cancel;
      dialog.querySelector('[value="confirm"]').textContent = action;
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    }));
    confirmationQueue = answer.catch(() => {});
    return answer;
  }

  async function newQuote() {
    if (state.projectBusy) return;
    if (projectHasChanges() && !await confirmReplace("Start a new project?", "Both estimates, project pricing and all three calculator drafts will be replaced with defaults using your saved pricing library.", "New project")) return;
    if (state.initialized) {
      try {
        const captured = projectStamp();
        const [prepared, penetration] = await Promise.all([window.CeasefireCalculators.prepareDefaults(), window.CeasefirePenetrations?.prepareDefaults(state.configuration)]);
        if (captured !== projectStamp()) throw new Error("The current project changed while preparing defaults. Try again when ready.");
        window.CeasefireCalculators.applyProject(prepared);
        if (penetration) window.CeasefirePenetrations.applyProject(penetration);
      } catch (error) { message(error.message, true); return; }
    }
    state.quoteContext++;
    state.quoteLoadRevision++;
    state.inputErrors.clear(); state.inputDrafts.clear();
    state.quote = null; state.quoteConfiguration = null; state.projectFile = null;
    resetProjectPricing();
    state.fields = clone(state.currentFields);
    // Start notes blank without changing workbook defaults or saved-quote inputs.
    state.inputs = Object.fromEntries(state.fields.map((field) => [field.cell, field.cell === "B12" ? "" : field.default ?? ""]));
    state.legacyTitle = "";
    for (const id of ["client", "site-address", "project-no"]) $(id).value = "";
    updateQuoteTitle();
    state.workflow = state.defaultWorkflow;
    $("measurements").value = "";
    $("snapshot-message").hidden = true;
    selectEstimator("estimate"); renderInputs(); updateDirty(false); message(""); showView("estimate"); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
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
      const penetration = window.CeasefirePenetrations?.quoteSnapshot?.();
      const penetrationStamp = window.CeasefirePenetrations?.quoteFingerprint?.();
      const payload = { title, inputs, workflow, measurements, configuration, ...details, ...(penetration ? { penetration } : {}) };
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
      const changedDuringSave = pricingChangedDuringSave || state.inputRevision !== inputRevision || state.inputErrors.size > 0 || JSON.stringify(state.inputs) !== JSON.stringify(inputs) || window.CeasefirePenetrations?.quoteFingerprint?.() !== penetrationStamp || JSON.stringify(window.CeasefirePenetrations?.quoteSnapshot?.()) !== JSON.stringify(penetration) || JSON.stringify(quoteDetails()) !== JSON.stringify(details) || $("quote-title").value.trim() !== title || state.workflow !== workflow || $("measurements").value !== measurements;
      updateDirty(changedDuringSave);
      message(changedDuringSave ? `Saved “${title}”. Changes made while saving still need to be saved.` : `Saved “${title}” with its inputs and pricing snapshot.`);
    } catch (error) { message(`Quote was not saved. ${error.message}`, true); }
    finally { button.disabled = false; }
  }

  async function loadQuotes() {
    const list = $("quote-list"); list.textContent = "Loading saved quotes…";
    try {
      const data = await request("/api/quotes");
      if (!(data.quotes || []).length) { list.replaceChildren(node("p", "empty-state", "No older estimate-only saves.")); return; }
      list.replaceChildren(...data.quotes.map((quote) => {
        const item = node("article", "quote-item");
        const description = node("div");
        description.append(node("h3", "", quote.title || "Untitled quote"));
        const date = new Date(quote.updated_at);
        description.append(node("p", "", Number.isNaN(date.getTime()) ? "Saved locally" : `Updated ${date.toLocaleString("en-AU")}`));
        const button = node("button", "button secondary", "Open older estimate");
        button.type = "button";
        button.addEventListener("click", () => openQuote(quote.id, button));
        item.append(description, button); return item;
      }));
    } catch (error) { list.replaceChildren(node("p", "message error", error.message)); }
  }

  async function openQuote(id, button) {
    if (state.projectBusy) return;
    button.disabled = true;
    const loadRevision = ++state.quoteLoadRevision;
    try {
      const quote = await request(`/api/quotes/${encodeURIComponent(id)}`);
      if (loadRevision !== state.quoteLoadRevision) return;
      const captured = projectStamp();
      const [prepared, penetration] = await Promise.all([window.CeasefireCalculators.prepareDefaults(), quote.penetration
        ? window.CeasefirePenetrations?.prepareProject(quote.penetration, quote.configuration || state.configuration)
        : window.CeasefirePenetrations?.prepareDefaults(quote.configuration || state.configuration)]);
      const scope = quote.penetration ? "This record contains the estimate, its firestopping schedule and original pricing. The current item and other calculators will start from defaults." : "This record contains the estimate and its original pricing only. The penetration schedule and all three calculators will start from defaults.";
      if (!await confirmReplace("Open this older estimate?", `${scope} The current estimate will be replaced. Save As can then save them together.`, "Open older estimate")) return;
      if (captured !== projectStamp()) throw new Error("The current project changed during review. Open the older estimate again when ready.");
      if (loadRevision !== state.quoteLoadRevision) return;
      state.quoteContext++;
      state.inputErrors.clear(); state.inputDrafts.clear();
      state.quote = quote;
      state.projectFile = null;
      window.CeasefireCalculators.applyProject(prepared);
      if (penetration) window.CeasefirePenetrations.applyProject(penetration);
      state.quoteConfiguration = clone(quote.configuration || state.configuration);
      resetProjectPricing("project");
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
      selectEstimator("estimate"); renderInputs(); updateDirty(false); message(""); showView("estimate"); scheduleCalculation();
      window.CeasefirePenetrations?.pricingChanged();
    } catch (error) { message(`Could not open the quote. ${error.message}`, true); }
    finally { button.disabled = false; }
  }

  function selectEstimator(kind) {
    if (!["estimate", "penetration"].includes(kind)) return;
    state.estimatorKind = kind;
    $("estimator-main").hidden = kind !== "estimate";
    $("estimator-penetration").hidden = kind !== "penetration";
    for (const button of document.querySelectorAll("[data-estimator-kind]")) button.setAttribute("aria-pressed", String(button.dataset.estimatorKind === kind));
    const libraryEditor = !!window.CeasefireLibraryEditor?.isOpen();
    $("firestopping-project-workspace").hidden = libraryEditor;
    $("firestopping-library-editor").hidden = !libraryEditor;
    $("estimator-penetration").setAttribute("aria-labelledby", libraryEditor ? "library-editor-heading" : "penetration-heading");
    if (kind === "penetration" && !libraryEditor) return window.CeasefirePenetrations?.open();
    if (kind === "estimate") return window.CeasefirePenetrations?.openSchedule?.();
  }

  function selectLibrary(kind, selection) {
    if (!["pricing", "penetration", "technical"].includes(kind)) return;
    document.activeElement?.blur?.();
    state.libraryKind = kind;
    for (const child of ["pricing", "penetration", "technical"]) $("library-" + child).hidden = child !== kind;
    for (const button of document.querySelectorAll("[data-library-kind]")) button.setAttribute("aria-pressed", String(button.dataset.libraryKind === kind));
    if (kind === "pricing") { if (!pricingViewCurrent()) renderPricing(); }
    else window.CeasefireLibraries?.open(kind, selection);
  }

  function showView(view, librarySelection) {
    state.currentView = view;
    clearTimeout(state.projectsTimer); ++state.projectsRevision;
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${view}`;
    for (const button of document.querySelectorAll("[data-view]")) {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    if (view === "quotes") loadProjects();
    if (view === "pricing") selectLibrary(state.libraryKind, librarySelection);
    if (view === "calculators") window.CeasefireCalculators?.open();
    const estimatorReady = view === "estimate" ? selectEstimator(state.estimatorKind) : undefined;
    // Each section starts with its heading and actions visible below the sticky
    // header, even when the previous estimate was scrolled far down the page.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return estimatorReady;
  }

  function getOverride(kind, id) { return state.draft[kind]?.[id] || {}; }

  function markPricingDirty() {
    state.pricingDirty = draftChanged(state.draft, pricingBaseline());
    if (state.pricingScope === "project") state.projectPricingDraft = state.draft;
    else state.libraryDraft = state.draft;
    $("pricing-status").textContent = state.pricingDirty ? "Unsaved pricing changes" : state.pricingScope === "project" ? "Project pricing" : "Saved library";
    updateProjectStatus();
  }

  function pricingBaseline() { return state.pricingScope === "project" ? state.quoteConfiguration || state.configuration : state.configuration; }
  function draftChanged(draft, baseline) { return !!draft && (pricingHasPendingInput(draft) || JSON.stringify(draft) !== JSON.stringify(baseline)); }
  function projectPricingChanged() { return draftChanged(state.pricingScope === "project" ? state.draft : state.projectPricingDraft, state.quoteConfiguration || state.configuration); }
  function projectHasChanges() { return state.dirty || projectPricingChanged() || window.CeasefireCalculators?.hasUnsavedChanges() || window.CeasefirePenetrations?.hasUnsavedChanges(); }
  function pricingScopeUi() {
    $("pricing-scope").value = state.pricingScope;
    $("save-pricing").textContent = state.pricingScope === "project" ? "Apply project pricing" : "Save pricing";
    $("pricing-context").textContent = state.pricingScope === "project"
      ? "These prices belong to the current project. Apply project pricing updates its estimate; Save stores them in the current file, or Save As creates another file. The shared library stays unchanged."
      : "Save pricing stores the shared library on this computer for future estimates. Discard changes returns to its last save. Existing projects keep their own pricing.";
  }
  function switchPricingScope(scope) {
    document.activeElement?.blur?.();
    if (scope === state.pricingScope) return;
    if (state.pricingScope === "project") state.projectPricingDraft = state.draft; else state.libraryDraft = state.draft;
    state.pricingScope = scope; ++state.pricingRevision;
    state.draft = scope === "project" ? state.projectPricingDraft ||= clone(state.quoteConfiguration || state.configuration) : state.libraryDraft ||= clone(state.configuration);
    pricingScopeUi(); refreshPricingCatalog(); renderPricing();
  }
  function resetProjectPricing(scope = state.pricingScope) {
    if (state.pricingScope === "library") state.libraryDraft = state.draft;
    state.projectPricingDraft = clone(state.quoteConfiguration || state.configuration);
    state.pricingScope = scope; ++state.pricingRevision;
    state.draft = scope === "project" ? state.projectPricingDraft : state.libraryDraft ||= clone(state.configuration);
    pricingScopeUi(); refreshPricingCatalog(); renderPricing();
  }

  async function previewProjectPricing() {
    document.activeElement?.blur?.();
    const draft = state.pricingScope === "project" ? state.draft : state.projectPricingDraft;
    if (!draft) return;
    if (pricingInputProblem(draft)) throw new Error(pricingInputProblem(draft));
    if (!draftChanged(draft, state.quoteConfiguration || state.configuration)) return;
    const captured = JSON.stringify(draft), context = state.quoteContext;
    const data = await request("/api/configuration/preview", { method: "POST", body: JSON.stringify({ configuration: clone(draft) }) });
    const currentDraft = state.pricingScope === "project" ? state.draft : state.projectPricingDraft;
    if (context !== state.quoteContext || currentDraft !== draft || captured !== JSON.stringify(draft) || pricingHasPendingInput(draft)) throw new Error("Project pricing changed while being checked. Apply it again when ready.");
    return data;
  }

  async function applyProjectPricing() {
    const data = await previewProjectPricing();
    if (!data) return;
    state.quoteConfiguration = clone(data.configuration); state.fields = clone(data.fields);
    state.projectPricingDraft = clone(data.configuration);
    if (state.pricingScope === "project") { state.draft = state.projectPricingDraft; refreshPricingCatalog(); renderPricing(); }
    renderInputs(); updateDirty(); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
    $("snapshot-message").hidden = false;
    $("snapshot-message").querySelector("span").textContent = "This project uses its own pricing. Save or Save As retains these prices in its file.";
  }

  async function useCurrentPricing() {
    if (state.projectBusy) return;
    if (projectPricingChanged() && !await confirmReplace("Use current library prices?", "The project's pricing edits will be replaced with the last saved shared library.", "Use current pricing")) return;
    state.quoteConfiguration = clone(state.configuration); state.fields = clone(state.currentFields);
    resetProjectPricing(); renderInputs(); updateDirty(); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
    $("snapshot-message").hidden = false;
    $("snapshot-message").querySelector("span").textContent = "Current saved library applied. Save or Save As to retain these prices.";
    message("Current saved library applied to this project. Check any removed product selections, then Save or Save As.");
  }

  function setOverride(kind, item, field, value) {
    state.draft[kind] ||= {};
    state.draft[kind][item.id] ||= {};
    const baseValue = kind === "rates" && field === "price" ? rateDefaultPrice(item) : item[field];
    if ((value === "" && field !== "yield") || value === baseValue) delete state.draft[kind][item.id][field];
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
    const saved = pricingBaseline(), savedCatalog = saved.catalog || state.baseline;
    const ownRate = (rate) => kind === "inventory" ? rate.inventory_id === item.id : rate.id === item.id;
    const original = kind === "inventory" ? savedCatalog.inventory.find((entry) => entry.id === item.id)
      : Object.values(savedCatalog.rate_groups).flat().find(ownRate);
    button.disabled = !original;
    button.setAttribute("aria-label", `Restore saved values and estimator uses for ${item.name}`);
    button.addEventListener("click", () => {
      if (!original) return;
      const affectedRates = new Set([...Object.values(state.catalog.rate_groups).flat(), ...Object.values(savedCatalog.rate_groups).flat()].filter(ownRate).map((rate) => rate.id));
      editPricingCatalog((catalog) => {
        if (kind === "inventory") catalog.inventory[catalog.inventory.findIndex((entry) => entry.id === item.id)] = clone(original);
        for (const [group, rates] of Object.entries(catalog.rate_groups)) {
          catalog.rate_groups[group] = rates.filter((rate) => !ownRate(rate));
          savedCatalog.rate_groups[group].forEach((rate, index) => {
            if (ownRate(rate)) catalog.rate_groups[group].splice(Math.min(index, catalog.rate_groups[group].length), 0, clone(rate));
          });
        }
      });
      if (kind === "inventory") {
        delete state.draft.inventory[item.id];
        if (saved.inventory?.[item.id]) state.draft.inventory[item.id] = clone(saved.inventory[item.id]);
      }
      for (const id of affectedRates) {
        delete state.draft.rates[id];
        if (saved.rates?.[id]) state.draft.rates[id] = clone(saved.rates[id]);
      }
      if (JSON.stringify(state.draft.catalog) === JSON.stringify(savedCatalog)) {
        if (!saved.catalog) delete state.draft.catalog;
        if (saved.catalog_signature) state.draft.catalog_signature = saved.catalog_signature;
      }
      for (const key of pricingPendingFields().keys()) if (key.startsWith(`${kind}:${item.id}:`)) pricingPendingFields().delete(key);
      refreshPricingCatalog(); markPricingDirty(); renderPricing();
    });
    return button;
  }

  const pricingFieldDrafts = new WeakMap();
  function pricingPendingFields(draft = state.draft) {
    if (!pricingFieldDrafts.has(draft)) pricingFieldDrafts.set(draft, new Map());
    return pricingFieldDrafts.get(draft);
  }
  function pricingInputProblem(draft = state.draft) {
    return [...pricingPendingFields(draft).values()].find((entry) => entry.error)?.error || "";
  }
  function pricingHasPendingInput(draft = state.draft) { return pricingPendingFields(draft).size > 0; }
  function pricingUseList(values) {
    return values.map((value) => /[;"\n\r]|^\s|\s$/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")).join("; ");
  }
  function parsePricingUses(text) {
    if (!text.trim()) return [];
    const values = []; let value = "", quoted = false, closed = false, quotedField = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
        else if (char === '"') { quoted = false; closed = true; }
        else value += char;
      } else if (char === ";") { values.push(quotedField ? value : value.trim()); value = ""; closed = false; quotedField = false; }
      else if (char === '"' && !value.trim() && !closed) { quoted = true; quotedField = true; value = ""; }
      else if (char === '"' || (closed && char.trim())) throw new Error("Use semicolons between values and double quotes around a name containing a semicolon.");
      else if (!closed) value += char;
    }
    if (quoted) throw new Error("Close the quoted value before continuing.");
    values.push(quotedField ? value : value.trim()); return values;
  }
  function pricingYieldUnit(group, rate) {
    return (rate.uses_yield ?? !!rate.source?.yield) ? (group === "mastic" ? "m / unit" : "m² / unit") : "";
  }
  function editPricingCatalog(edit) {
    const catalog = clone(state.draft.catalog || state.catalog);
    edit(catalog);
    state.draft.catalog = catalog;
    delete state.draft.catalog_signature;
    refreshPricingCatalog();
    markPricingDirty();
  }
  function pricingFieldInput(record, field, initial, apply, placeholder = "", multiline = false) {
    const input = node(multiline ? "textarea" : "input", "pricing-use-list");
    if (multiline) input.rows = 2; else input.type = "text";
    const key = `${record.key}:${field}`;
    input.dataset.priceField = field;
    input.value = pricingPendingFields().get(key)?.value ?? initial;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", `${record.item.name}: ${field}`);
    const invalid = pricingPendingFields().get(key)?.error;
    if (invalid) { input.setCustomValidity?.(invalid); input.setAttribute("aria-invalid", "true"); }
    input.addEventListener("input", () => {
      pricingPendingFields().set(key, { value: input.value, error: "Finish editing the pricing field before saving." });
      markPricingDirty();
    });
    input.addEventListener("change", () => {
      try {
        if (input.value !== initial) apply(input.value);
        pricingPendingFields().delete(key);
        input.setCustomValidity?.(""); input.removeAttribute("aria-invalid");
        markPricingDirty(); renderPricing();
      } catch (error) {
        const text = `${record.item.name}: ${error.message}`;
        pricingPendingFields().set(key, { value: input.value, error: text });
        input.setCustomValidity?.(text); input.setAttribute("aria-invalid", "true"); message(text, true); markPricingDirty();
      }
    });
    return input;
  }
  function pricingListInput(record, field, values, apply, placeholder = "") {
    return pricingFieldInput(record, field, pricingUseList(values), (text) => apply(parsePricingUses(text)), placeholder);
  }
  function productServiceName(record) {
    const product = { ...record.item, ...getOverride(record.kind, record.item.id) };
    if (product.product_service) return product.product_service;
    const rates = record.uses.map(({ item }) => ({ ...item, ...getOverride("rates", item.id) }));
    const explicit = rates.find((rate) => rate.product_service);
    if (explicit) return explicit.product_service;
    const candidates = [...(record.kind === "inventory" ? [product.sales_description, product.name] : []), ...rates.flatMap((rate) => [rate.display_name, rate.name])].filter((text) => typeof text === "string" && text.trim());
    return candidates.reduce((best, text) => text.trim().length > best.trim().length ? text : best, "");
  }
  function setProductService(record, text) {
    if (!text.trim() || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Product/Service must contain 1 to 1,000 characters without unsupported control characters.");
    setOverride(record.kind, record.item, "product_service", text);
  }
  function sharedPricingYield(record) {
    const uses = record.uses.filter(({ item }) => item.uses_yield ?? !!item.source?.yield);
    const values = uses.map(({ item }) => Object.hasOwn(getOverride("rates", item.id), "yield") ? getOverride("rates", item.id).yield : item.yield);
    const units = [...new Set(uses.map(({ group, item }) => pricingYieldUnit(group, item)))];
    const mixed = values.some((value) => value !== values[0]);
    // Both stored blank kinds look empty; retain their distinct calculation
    // values until the user actually edits the yield.
    const value = !values.length ? "" : mixed ? "Mixed" : values[0] === null || values[0] === "" ? "" : String(values[0]);
    return { uses, values, units, mixed, value };
  }
  function setSharedPricingYield(record, text) {
    const shared = sharedPricingYield(record), token = text.trim().toLowerCase();
    if (!shared.uses.length) throw new Error("This item does not use a yield.");
    if (shared.units.length > 1) throw new Error("This item has different yield units. Its individual yields must be retained; edit them separately in the workbook's hidden Use yields fields.");
    let value;
    if (!token || token === "blank") value = null;
    else if (token === "empty text") value = "";
    else {
      if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(token) || !Number.isFinite(Number(token)) || Number(token) > 1e12) throw new Error("Yield must be one nonnegative number or left blank. Semicolon lists are not needed.");
      value = Number(token);
    }
    for (const { item } of shared.uses) setOverride("rates", item, "yield", value);
  }
  function setPricingUses(record, labels) {
    const categories = Object.keys(state.catalog.rate_groups);
    const sharedYield = sharedPricingYield(record);
    const selected = labels.map((label) => categories.find((key) => key.toLowerCase() === label.toLowerCase() || (groups[key] || key).toLowerCase() === label.toLowerCase()));
    if (selected.some((group) => !group)) throw new Error(`Choose existing uses: ${categories.map((key) => groups[key] || key).join("; ")}.`);
    if (record.kind !== "inventory" && selected.length !== 1) throw new Error("A standalone rate needs exactly one use.");
    const retained = new Set(), removed = [];
    editPricingCatalog((catalog) => {
      const old = record.uses.map((use) => ({ group: use.group, item: clone(use.item) }));
      const matched = selected.map((group) => {
        const match = old.find((use) => use.group === group && !retained.has(use.item.id));
        if (match) { retained.add(match.item.id); return match; }
        return { group, item: null };
      });
      for (const use of old) if (!retained.has(use.item.id)) removed.push(use.item.id);
      for (const group of categories) catalog.rate_groups[group] = catalog.rate_groups[group].filter((rate) => !removed.includes(rate.id));
      for (const use of matched) {
        if (use.item) continue;
        const template = old.find((entry) => removed.includes(entry.item.id));
        const usesYield = Boolean(catalog.rate_group_rules?.[use.group]?.yield_column) || catalog.rate_groups[use.group].some((rate) => rate.uses_yield);
        const item = record.kind === "rates" && template ? clone(template.item) : {
          id: `rate_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`,
          name: getOverride(record.kind, record.item.id).name || record.item.name,
          inventory_id: record.kind === "inventory" ? record.item.id : null,
          price: record.kind === "inventory" ? inventorySellPrice(record.item) : rateSellPrice(record.item),
          price_mode: record.kind === "inventory" ? "inventory" : "override", source: {},
        };
        let name = item.name, suffix = 2;
        while (catalog.rate_groups[use.group].some((rate) => rate.name.toLowerCase() === name.toLowerCase())) name = `${item.name} (${suffix++})`;
        item.name = name; item.uses_yield = usesYield;
        item.yield = usesYield && !sharedYield.mixed && sharedYield.units.length === 1 && sharedYield.units[0] === pricingYieldUnit(use.group, item) ? sharedYield.values[0] : null;
        // Reuse a single compatible yield, never reinterpret area as length.
        delete item.yield_unit;
        catalog.rate_groups[use.group].push(item);
      }
    });
    for (const id of removed) if (!Object.values(state.catalog.rate_groups).some((rates) => rates.some((rate) => rate.id === id))) delete state.draft.rates[id];
  }
  function setPricingUseValues(record, values, field) {
    if (field === "Yield unit") throw new Error("Yield units are determined by the calculation and cannot be edited.");
    if (!values.length && record.uses.length === 1) values = [""];
    if (values.length !== record.uses.length) throw new Error(`Enter ${record.uses.length} semicolon-separated ${field} values, in the same order as Used in Estimator.`);
    const updates = record.uses.map(({ group, item }, index) => {
      const value = values[index], usesYield = item.uses_yield ?? !!item.source?.yield;
      if (field === "Selection name") {
        if (!value || value.length > 1000) throw new Error("Selection names must contain 1 to 1,000 characters.");
        if (state.catalog.rate_groups[group].some((rate) => rate.id !== item.id && rate.name.toLowerCase() === value.toLowerCase())) throw new Error(`Selection name already exists in ${groups[group] || group}.`);
        return { group, item, value };
      }
      if (field === "Yield") {
        if (!usesYield) {
          if (value && value !== "—") throw new Error(`${groups[group] || group} does not use a yield.`);
          return { group, item, value: undefined };
        }
        if (!value || value.toLowerCase() === "blank") return { group, item, value: null };
        if (value.toLowerCase() === "empty text") return { group, item, value: "" };
      } else if (!value) {
        if (!item.inventory_id) throw new Error("Standalone rates need a sell rate.");
        return { group, item, value: null };
      }
      const number = Number(value);
      if (!value || !Number.isFinite(number) || number < 0 || number > 1e12) throw new Error(`${field} values must be nonnegative numbers no greater than one trillion.`);
      return { group, item, value: number };
    });
    if (field === "Selection name") {
      for (const group of new Set(updates.map((entry) => entry.group))) {
        const names = updates.filter((entry) => entry.group === group).map((entry) => entry.value.toLowerCase());
        if (new Set(names).size !== names.length) throw new Error(`Selection names must be unique within ${groups[group] || group}.`);
      }
    }
    if (field === "Yield") for (const { item, value } of updates) {
      if (value !== undefined) setOverride("rates", item, "yield", value);
    }
    else editPricingCatalog((catalog) => {
      for (const { group, item, value } of updates) {
        const rate = catalog.rate_groups[group].find((entry) => entry.id === item.id);
        if (field === "Selection name") { rate.name = value; delete rate.display_name; }
        else {
          rate.price_mode = value === null ? "inventory" : "override";
          rate.price = value === null ? inventorySellPrice(state.catalog.inventory.find((entry) => entry.id === item.inventory_id)) : value;
        }
      }
    });
    if (field === "Sell rate override") for (const { item } of updates) {
      const patch = state.draft.rates[item.id];
      if (patch) { delete patch.price; if (!Object.keys(patch).length) delete state.draft.rates[item.id]; }
    }
  }

  async function resetPricingLibrary() {
    document.activeElement?.blur?.();
    const scope = state.pricingScope, draft = state.draft, snapshot = JSON.stringify(draft), pending = JSON.stringify([...pricingPendingFields(draft)]);
    const saveAction = scope === "project" ? "Apply project pricing" : "Save pricing";
    if (!await confirmReplace(scope === "project" ? "Reset project pricing?" : "Reset Library?", `Replace this pricing draft with the application's original products, rates and yields. Click ${saveAction} to keep these defaults. Existing project files keep their own pricing.`, "Reset Library")) return;
    if (state.pricingScope !== scope || state.draft !== draft || JSON.stringify(state.draft) !== snapshot || JSON.stringify([...pricingPendingFields(draft)]) !== pending) {
      message("Pricing changed during reset confirmation. Review the current pricing draft and try Reset Library again.", true); return;
    }
    state.draft = { inventory: {}, rates: {} }; refreshPricingCatalog(); renderPricing();
    message(`Original library defaults are ready as a draft. Click ${saveAction} to keep them, or Discard changes to restore the ${scope === "project" ? "last applied project pricing" : "last saved library"}.`);
  }

  function pricingViewState() {
    // Retain the controls when navigation has changed no pricing data. Include
    // values, not just object identities: edits and saved baselines can change
    // in place. Pending field text already belongs to the retained controls.
    // Replacement objects still need fresh controls: handlers capture records,
    // and pending field drafts belong to one specific pricing draft object.
    const references = [state.draft, state.catalog, pricingBaseline(), state.baseline];
    return { references, key: JSON.stringify([references, state.pricingScope,
      $("pricing-search").value, $("rate-group").value, !!$("show-rate-overrides").checked]) };
  }

  function pricingViewCurrent() {
    if (!state.pricingRender) return false;
    const current = pricingViewState();
    return current.key === state.pricingRender.key && current.references.every((value, index) => value === state.pricingRender.references[index]);
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
    const productText = (record) => `${productServiceName(record)} ${record.item.name} ${record.item.sales_description || ""} ${record.item.item_code || ""}`.toLocaleLowerCase();
    const matches = records.filter((record) => {
      const groupMatch = !selectedGroup || (selectedGroup === "not-used" ? !record.uses.length : record.uses.some((use) => use.group === selectedGroup));
      const useText = record.uses.map(({ group, item }) => `${groups[group] || group} ${item.name} ${item.display_name || ""}`).join(" ").toLocaleLowerCase();
      return groupMatch && `${productText(record)} ${useText}`.includes(search);
    });
    $("pricing-count").textContent = `${matches.length} of ${records.length} products and standalone rates`;
    $("pricing-help").textContent = "Edit Product/Service without changing existing estimate selections. One yield applies to all uses with the same unit; Mixed preserves differing saved values until you edit it. Uses remain separated by semicolons. Saved rate overrides are retained; select Show rate overrides to review or change them.";
    const heading = node("tr");
    for (const title of ["Item code", "Product/Service", "Supplier price", "Markup %", "Sell price", "Used in Estimator", "Yield", "Yield unit", "Sell rate override", ""]) {
      const cell = node("th", "", title);
      if (title === "Sell rate override") cell.hidden = !$("show-rate-overrides").checked;
      heading.append(cell);
    }
    $("pricing-head").replaceChildren(heading);
    const refreshers = [], refreshPrices = () => refreshers.forEach((refresh) => refresh());
    const rows = [];
    for (const record of matches) {
      const { item, kind, uses } = record, inventoryView = kind === "inventory";
      const row = node("tr", state.draft[kind]?.[item.id] ? "edited" : "");
      row.dataset.priceId = item.id; row.dataset.priceKind = kind;
      const codeCell = node("td");
      if (inventoryView) codeCell.append(pricingListInput(record, "Item code", [item.item_code ?? ""], (values) => {
        if (values.length > 1 || (values[0] || "").length > 200) throw new Error("Enter one item code of at most 200 characters.");
        editPricingCatalog((catalog) => { catalog.inventory.find((entry) => entry.id === item.id).item_code = values[0] || ""; });
      }));
      else codeCell.textContent = "—";
      row.append(codeCell);
      const nameCell = node("td");
      nameCell.append(pricingFieldInput(record, "Product/Service", productServiceName(record), (text) => setProductService(record, text), "", true));
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
        const rateNotice = node("small", "subtext pricing-rate-notice");
        refreshers.push(() => {
          const separate = uses.filter(({ item: rate }) => Object.hasOwn(getOverride("rates", rate.id), "price") || rate.price_mode === "override" || rateSellPrice(rate) !== inventorySellPrice(item));
          rateNotice.hidden = !separate.length;
          rateNotice.textContent = separate.length ? `Saved estimator rates: ${separate.map(({ group, item: rate }) => `${groups[group] || group} ${formatMoney(rateSellPrice(rate))}`).join("; ")}. Show rate overrides to review.` : "";
        });
        sell.append(rateNotice); row.append(supplier, markup, sell);
      } else {
        const sell = node("td"); sell.append(priceInput(kind, item, "price", { defaultValue: rateSellPrice(item), label: "Sell price", onChange: refreshPrices }));
        row.append(node("td", "", "—"), node("td", "", "—"), sell);
      }
      const groupCell = node("td");
      groupCell.append(pricingListInput(record, "Used in Estimator", uses.map(({ group }) => groups[group] || group), (values) => setPricingUses(record, values), "Not used"));
      row.append(groupCell);
      const shared = sharedPricingYield(record), yieldCell = node("td");
      if (shared.uses.length) {
        const input = pricingFieldInput(record, "Yield", shared.value, (text) => setSharedPricingYield(record, text));
        input.readOnly = shared.units.length > 1;
        yieldCell.append(input);
        if (shared.mixed || shared.units.length > 1) yieldCell.append(node("small", "subtext", shared.units.length > 1 ? "Different units: individual yields retained." : "Different saved yields: enter one value to apply it to all uses."));
      } else yieldCell.textContent = "—";
      row.append(yieldCell, node("td", "pricing-yield-unit", shared.units.join("; ")));
      const overrides = node("td"); overrides.hidden = !$("show-rate-overrides").checked;
      if (uses.length && inventoryView) {
        overrides.append(pricingListInput(record, "Sell rate override", uses.map(({ item: rate }) => Object.hasOwn(getOverride("rates", rate.id), "price") || rate.price_mode === "override" || !rate.inventory_id ? rateSellPrice(rate) : ""), (entries) => setPricingUseValues(record, entries, "Sell rate override"), "Uses item sell price"));
        const status = node("small", "subtext pricing-rate-source");
        refreshers.push(() => { status.textContent = pricingUseList(uses.map(({ item: rate }) => formatMoney(rateSellPrice(rate)))); });
        overrides.append(status);
      } else overrides.textContent = inventoryView ? "—" : "Uses Sell price";
      const reset = node("td"); reset.append(resetButton(kind, item)); row.append(overrides, reset);
      rows.push(row);
    }
    if (!rows.length) { const row = node("tr"); const cell = node("td", "empty-state", "No matching products or rates."); cell.colSpan = $("show-rate-overrides").checked ? 10 : 9; row.append(cell); rows.push(row); }
    $("pricing-body").replaceChildren(...rows);
    refreshPrices();
    markPricingDirty();
    state.pricingRender = pricingViewState();
  }

  async function savePricing() {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    const button = $("save-pricing"); button.disabled = true;
    $("use-current-pricing").disabled = true;
    let persisted = false;
    try {
      if (state.pricingScope === "project") {
        await applyProjectPricing();
        message("Project pricing applied. Save or Save As to store it with the estimate and calculators.");
        return;
      }
      const draftObject = state.draft;
      const draft = clone(state.draft);
      const configuration = await request("/api/configuration", { method: "PUT", body: JSON.stringify(draft) });
      persisted = true;
      const metadata = await request("/api/bootstrap");
      // Keep prices and their dropdown definitions in step. Until both arrive,
      // estimates continue using the previously loaded pricing configuration.
      const previousConfiguration = state.configuration;
      state.configuration = clone(metadata.configuration || configuration);
      state.currentFields = clone(metadata.fields || state.currentFields);
      const unchanged = JSON.stringify(draftObject) === JSON.stringify(draft) && !pricingHasPendingInput(draftObject);
      if (state.libraryDraft === draftObject && unchanged) state.libraryDraft = clone(state.configuration);
      if (state.pricingScope === "library" && state.draft === draftObject && unchanged) state.draft = state.libraryDraft || clone(state.configuration);
      if (!state.quoteConfiguration) {
        state.fields = clone(state.currentFields);
        if (!draftChanged(state.projectPricingDraft, previousConfiguration)) {
          state.projectPricingDraft = clone(state.configuration);
          if (state.pricingScope === "project") state.draft = state.projectPricingDraft;
        }
        renderInputs(); updateDirty(); scheduleCalculation();
        window.CeasefirePenetrations?.pricingChanged();
      }
      refreshPricingCatalog(); renderPricing();
      const changedElsewhere = JSON.stringify(state.configuration) !== JSON.stringify(configuration);
      message(changedElsewhere ? "Pricing was saved, then changed in another session. The latest saved library is loaded; any further draft edits are still unsaved."
        : state.pricingDirty ? "Pricing saved. Changes made while saving are still unsaved." : "Pricing library saved. The saved products, choices and rates now apply to new estimates.");
    } catch (error) { message(persisted ? `Pricing was saved, but the updated dropdowns could not be loaded. Reload the app before starting another estimate. ${error.message}` : `Pricing was not saved. ${error.message}`, true); }
    finally { button.disabled = false; $("use-current-pricing").disabled = false; }
  }

  async function exportPricing() {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    const button = $("export-pricing");
    if (button.disabled) return;
    const draft = JSON.stringify(state.draft);
    button.disabled = true; button.textContent = "Exporting…";
    try {
      const saved = await window.CeasefireDownloads.save("/api/pricing/export", { configuration: JSON.parse(draft) });
      message(draft === JSON.stringify(state.draft)
        ? `Excel saved to ${saved.path}. It includes all inventory and rate groups, including your unsaved pricing edits.`
        : `Excel saved to ${saved.path} using the pricing captured when you clicked Export Excel. Later edits are not included.`);
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
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    const input = $("pricing-import-file");
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const button = $("import-pricing");
    const sourceDraft = state.draft, draft = JSON.stringify(sourceDraft);
    button.disabled = true; button.textContent = "Reading Excel…";
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an .xlsx workbook exported from this pricing library.");
      if (file.size > 5 * 1024 * 1024) throw new Error("The workbook must be 5 MB or smaller.");
      const content = await fileBase64(file);
      const preview = await request("/api/pricing/import", {
        method: "POST", body: JSON.stringify({ filename: file.name, content_base64: content, configuration: JSON.parse(draft) }),
      });
      if (state.draft !== sourceDraft || draft !== JSON.stringify(state.draft) || pricingInputProblem()) throw new Error("Pricing changed while the workbook was being read. Import it again to compare against your latest edits.");
      const counts = (kind, label) => {
        const count = preview.summary?.[kind] || {};
        return `${label}: ${count.added || 0} added, ${count.removed || 0} removed, ${count.updated || 0} updated.`;
      };
      const saveAction = $("save-pricing").textContent || "Save pricing";
      const detail = `${file.name}\n${counts("inventory", "Inventory")}\n${counts("rates", "Rates and choices")}\nThis replaces the entire draft library. Deleted workbook rows will be removed. The changes take effect only after you click ${saveAction}.`;
      const accepted = await confirmReplace("Review imported pricing", detail, "Apply to draft");
      if (!accepted) { message("Import cancelled. Your pricing draft was kept."); return; }
      if (state.draft !== sourceDraft || draft !== JSON.stringify(state.draft) || pricingInputProblem()) throw new Error("Pricing changed during import review. Import again to keep your latest edits safe.");
      state.draft = clone(preview.configuration);
      refreshPricingCatalog(); renderPricing();
      message(`Imported pricing is ready to review. Click ${saveAction} to apply the new products, dropdown choices and rates.`);
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
      state.libraryDraft = state.draft;
      if (Array.isArray(data.workflows) && data.workflows.length) {
        state.defaultWorkflow = data.workflows[0];
      }
      refreshPricingCatalog();
      $("loading-state").hidden = true;
      await newQuote();
      showView("home");
      state.initialized = true;
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
      ...(window.CeasefirePenetrations?.quoteSnapshot?.() ? { penetration: window.CeasefirePenetrations.quoteSnapshot() } : {}),
      ...(state.quote ? { source_quote_id: state.quote.id } : {}),
    };
  }

  function projectEstimate() {
    const payload = reportPayload(); delete payload.source_quote_id; delete payload.penetration; return payload;
  }

  function projectStamp() {
    return JSON.stringify({ estimate: projectEstimate(), quoteContext: state.quoteContext,
      quoteLoadRevision: state.quoteLoadRevision, inputRevision: state.inputRevision,
      errors: [...state.inputErrors], inputDrafts: [...state.inputDrafts],
      pricing: state.pricingScope === "project" ? state.draft : state.projectPricingDraft,
      pricingPending: (state.pricingScope === "project" ? state.draft : state.projectPricingDraft) && [...pricingPendingFields(state.pricingScope === "project" ? state.draft : state.projectPricingDraft)],
      calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations?.projectFingerprint() });
  }

  function projectBusy(value) {
    state.projectBusy = value;
    for (const id of ["save-project", "save-current-project", "load-project", "link-project-folder", "new-quote", "use-current-pricing"]) { $(id).disabled = value; $(id).setAttribute("aria-busy", String(value)); }
    updateProjectStatus();
  }

  async function saveProject(saveAs = true) {
    if (state.projectBusy) return;
    const target = state.projectFile, context = state.quoteContext;
    if (!saveAs && !target?.save_token) {
      const dialog = $("save-required-dialog");
      if (!dialog.open) dialog.showModal();
      return;
    }
    projectBusy(true);
    try {
      document.activeElement?.blur?.();
      if (inputProblem()) throw new Error(inputProblem());
      // Validate the project pricing draft without applying it yet. Cancelling
      // Save As or a failed write must retain the exact current editing state.
      const pricing = await previewProjectPricing();
      if (inputProblem()) throw new Error(inputProblem());
      const pricingStamp = () => {
        const draft = state.pricingScope === "project" ? state.draft : state.projectPricingDraft;
        return JSON.stringify([state.quoteConfiguration || state.configuration, draft, draft ? [...pricingPendingFields(draft)] : []]);
      };
      const preparedPricing = pricingStamp();
      const [calculators, penetration] = await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations?.completeProjectSnapshot()]);
      if (window.CeasefirePenetrations?.inputProblem()) throw new Error(window.CeasefirePenetrations.inputProblem());
      if (context !== state.quoteContext || target !== state.projectFile || inputProblem() || preparedPricing !== pricingStamp()) throw new Error(inputProblem() || "The project changed while preparing the file. Save again when ready.");
      if (JSON.stringify(calculators) !== JSON.stringify(window.CeasefireCalculators.projectSnapshot()) || penetration && JSON.stringify(penetration) !== JSON.stringify(window.CeasefirePenetrations.projectSnapshot())) throw new Error("The calculator drafts changed while preparing the file. Save again when ready.");
      const payload = { estimate: projectEstimate(), calculators, ...(penetration ? { penetration } : {}) };
      if (pricing) payload.estimate.configuration = clone(pricing.configuration);
      if (!saveAs) payload.save_token = target.save_token;
      const captured = projectStamp();
      const saved = await request(saveAs ? "/api/project/save-as" : "/api/project/save", { method: "POST", body: JSON.stringify(payload) });
      if (saved.cancelled) { message("Save As cancelled. Your current project remains open."); return; }
      const changed = captured !== projectStamp();
      if (context === state.quoteContext) {
        state.projectFile = saved.file;
        window.CeasefireCalculators.markProjectSaved(saved.project.calculators, calculators);
        if (penetration) window.CeasefirePenetrations.markProjectSaved(saved.project.penetration, penetration);
        if (!changed) {
          state.quote = null; state.quoteConfiguration = clone(saved.project.estimate.configuration);
          state.fields = clone(saved.project.fields); resetProjectPricing(); renderInputs(); updateDirty(false); scheduleCalculation();
          window.CeasefirePenetrations?.pricingChanged();
          $("snapshot-message").hidden = false;
          $("snapshot-message").querySelector("span").textContent = "This project uses the pricing saved in its file.";
        } else updateDirty();
      }
      message(`Project saved to ${saved.file.path}. It includes both estimates, the pricing library and all three calculators.${changed ? " Later edits are not included and still need saving." : ""}${saved.warning ? ` ${saved.warning}` : ""}`);
    } catch (error) { message(`Project was not saved. ${error.message}`, true); }
    finally { projectBusy(false); }
  }

  async function openNativeProject() {
    if (state.projectBusy) return;
    projectBusy(true);
    try {
      const captured = projectStamp();
      const project = await request("/api/project/open", { method: "POST", body: "{}" });
      if (project.cancelled) { message("Project load cancelled. Your current drafts were kept."); return; }
      await reviewAndLoadProject(project, project.file, captured);
    } catch (error) { message(`Project was not loaded. ${error.message}`, true); }
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
      await reviewAndLoadProject(project, { name: file.name, ...(file.lastModified ? { modified_at: new Date(file.lastModified).toISOString() } : {}) }, captured);
    } catch (error) { message(`Project was not loaded. ${error.message}`, true); }
    finally { projectBusy(false); }
  }

  async function reviewAndLoadProject(project, file, captured) {
      const [prepared, penetration] = await Promise.all([window.CeasefireCalculators.prepareProject(project.calculators), window.CeasefirePenetrations?.prepareProject(project.penetration, project.estimate.configuration)]);
      if (captured !== projectStamp()) throw new Error("Your draft changed while reading the file. Load it again when ready.");
      const detail = project.project_details || {};
      const accepted = await confirmReplace("Load this project?", `${file.name}\nProject No.: ${detail.project_no || "Not recorded"}\nClient: ${detail.client || "Not recorded"}\nSite Address: ${detail.site_address || "Not recorded"}\n\nThis replaces both estimates, their pricing and all three calculator drafts. The shared pricing library stays unchanged.`, "Load Project");
      if (!accepted) { message("Project load cancelled. Your current drafts were kept."); return; }
      if (captured !== projectStamp()) throw new Error("Your draft changed during review. Load the file again to keep your latest edits safe.");
      const estimate = project.estimate;
      // All validation and definition loading finish before either workspace changes.
      const inputs = clone(estimate.inputs), configuration = clone(estimate.configuration), fields = clone(project.fields);
      window.CeasefireCalculators.applyProject(prepared);
      window.CeasefireCalculators.markProjectSaved(project.calculators);
      if (penetration) window.CeasefirePenetrations.applyProject(penetration);
      ++state.quoteContext; ++state.quoteLoadRevision;
      state.inputErrors.clear(); state.inputDrafts.clear();
      state.quote = null; state.quoteConfiguration = configuration; state.fields = fields; state.inputs = inputs;
      state.projectFile = file; resetProjectPricing("project");
      state.legacyTitle = [estimate.project_no, estimate.client, estimate.site_address].some(Boolean) ? "" : estimate.title || "";
      $("project-no").value = estimate.project_no || ""; $("client").value = estimate.client || ""; $("site-address").value = estimate.site_address || "";
      state.workflow = estimate.workflow; $("measurements").value = estimate.measurements || "";
      updateQuoteTitle(); renderInputs(); updateDirty(false);
      $("snapshot-message").hidden = false; $("snapshot-message").querySelector("span").textContent = "This project uses the pricing snapshot from its file.";
      selectEstimator("estimate"); showView("estimate"); scheduleCalculation();
      window.CeasefirePenetrations?.pricingChanged();
      message(file.save_token
        ? "Project loaded with both estimates, its original pricing and all three calculators. Save updates this file; Save As stores the complete project in another file."
        : "Project imported with both estimates, its original pricing and all three calculators. Use Save As to choose its project file.");
  }

  async function loadProjects({ refresh = false, offset = state.projectsOffset } = {}) {
    clearTimeout(state.projectsTimer);
    const revision = ++state.projectsRevision;
    const list = $("project-list"); list.setAttribute("aria-busy", "true");
    const search = $("project-search").value.trim(), sort = $("project-sort").value || "modified_desc";
    const query = [];
    if (search) query.push(`search=${encodeURIComponent(search)}`);
    if (sort !== "modified_desc") query.push(`sort=${encodeURIComponent(sort)}`);
    if (offset) query.push(`offset=${offset}`);
    if (refresh) query.push("refresh=1");
    try {
      const data = await request(`/api/projects${query.length ? `?${query.join("&")}` : ""}`);
      if (revision !== state.projectsRevision) return;
      if (!data.scan_pending && offset > 0 && data.matched !== undefined && offset >= data.matched) {
        return loadProjects({ offset: data.matched ? Math.floor((data.matched - 1) / 100) * 100 : 0 });
      }
      $("project-folder").textContent = data.folder || "Link your estimates folder to list its project files and use it as the default Save As location.";
      state.projectsOffset = data.offset ?? offset;
      const items = (data.files || []).map(file => {
        const item = node("article", "quote-item"), description = node("div");
        description.append(node("h3", "", file.title || file.name), node("p", "", [file.project_no, file.client, file.site_address].filter(Boolean).join(" · ")), node("p", "helper project-relative-path", file.relative_path || file.name), node("p", "helper", `Saved ${new Date(file.modified_at).toLocaleString("en-AU")}`));
        const button = node("button", "button secondary", "Open project"); button.type = "button";
        button.addEventListener("click", () => openProjectFile(file, button)); item.append(description, button); return item;
      });
      list.replaceChildren(...(items.length ? items : [node("p", "empty-state", data.scan_pending ? "Scanning the linked folder and subfolders…" : search ? "No projects match this search." : "No project files in the linked folder or its subfolders yet.")]));
      const matched = data.matched ?? items.length, total = data.total ?? matched, first = items.length ? state.projectsOffset + 1 : 0;
      $("project-list-status").textContent = `${first}–${items.length ? state.projectsOffset + items.length : 0} of ${matched} matching projects · ${total} found${data.scan_pending ? ` · Scanning subfolders (${data.scanned_entries || 0} entries checked)…` : ""}`;
      $("project-previous").disabled = !state.projectsOffset;
      $("project-next").disabled = state.projectsOffset + items.length >= matched;
      $("project-continue").hidden = !data.scan_pending;
      const problems = (data.errors || []).map(item => `${item.name}: ${item.error}`);
      if (data.error_count > problems.length) problems.push(`${data.error_count - problems.length} additional entries could not be listed.`);
      if (data.truncated && !data.scan_pending) problems.push("Some entries could not be listed. Refresh to try again; details are shown below.");
      $("project-file-errors").textContent = problems.join("\n"); $("project-file-errors").hidden = !problems.length;
      if (data.scan_pending && state.currentView === "quotes") state.projectsTimer = setTimeout(() => { if (revision === state.projectsRevision && state.currentView === "quotes") loadProjects(); }, 250);
    } catch (error) {
      if (revision === state.projectsRevision) {
        list.replaceChildren(node("p", "message error", error.message));
        $("project-list-status").textContent = "Project list unavailable · use Refresh to retry";
        $("project-continue").hidden = true;
      }
    } finally { if (revision === state.projectsRevision) list.setAttribute("aria-busy", "false"); }
  }

  async function linkProjectFolder() {
    if (state.projectBusy) return;
    projectBusy(true);
    try {
      const data = await request("/api/projects/link-folder", { method: "POST", body: "{}" });
      if (data.cancelled) { message("Folder selection cancelled."); return; }
      state.projectsOffset = 0;
      await loadProjects(); message(`Estimates folder linked: ${data.folder}`);
    } catch (error) { message(`Folder was not linked. ${error.message}`, true); }
    finally { projectBusy(false); }
  }

  async function openProjectFile(file, button) {
    if (state.projectBusy) return;
    projectBusy(true); button.disabled = true;
    try {
      const captured = projectStamp();
      const project = await request("/api/projects/load", { method: "POST", body: JSON.stringify({ id: file.id }) });
      await reviewAndLoadProject(project, project.file || file, captured);
    } catch (error) { message(`Project was not loaded. ${error.message}`, true); }
    finally { projectBusy(false); button.disabled = false; }
  }

  async function downloadQuotePdf() {
    if (inputProblem()) { message(inputProblem(), true); return; }
    const button = $("download-quote-pdf");
    if (button.disabled) return;
    const payload = reportPayload();
    const quoteContext = state.quoteContext;
    const capturedPayload = JSON.stringify(payload);
    const penetrationStamp = window.CeasefirePenetrations?.quoteFingerprint?.();
    const savedReportId = state.quote && !state.dirty ? state.quote.id : null;
    const reportPath = savedReportId ? `/api/quotes/${encodeURIComponent(savedReportId)}/report.pdf` : "/api/quote-report";
    button.disabled = true;
    button.textContent = "Preparing PDF…";
    button.setAttribute("aria-busy", "true");
    try {
      const saved = await window.CeasefireDownloads.save(reportPath, savedReportId ? {} : payload);
      const estimateChanged = quoteContext !== state.quoteContext || capturedPayload !== JSON.stringify(reportPayload()) || window.CeasefirePenetrations?.quoteFingerprint?.() !== penetrationStamp;
      message(estimateChanged
        ? `PDF saved to ${saved.path} for “${payload.title}” using ${savedReportId ? "its saved result and pricing snapshot" : "the inputs and pricing captured when you clicked Download PDF"}. Later edits are not included.`
        : `PDF saved to ${saved.path} for “${payload.title}”.`);
    } catch (error) { message(`PDF for “${payload.title}” was not downloaded. ${error.message}`, true); }
    finally {
      button.disabled = false;
      button.textContent = "Download PDF";
      button.removeAttribute("aria-busy");
    }
  }

  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => showView(button.dataset.view));
  for (const button of document.querySelectorAll("[data-home-view]")) button.addEventListener("click", () => showView(button.dataset.homeView));
  for (const button of document.querySelectorAll("[data-estimator-kind]")) button.addEventListener("click", () => selectEstimator(button.dataset.estimatorKind));
  for (const button of document.querySelectorAll("[data-library-kind]")) button.addEventListener("click", () => selectLibrary(button.dataset.libraryKind));
  for (const id of ["client", "site-address", "project-no"]) $(id).addEventListener("input", () => { updateQuoteTitle(); updateDirty(); });
  $("measurements").addEventListener("input", () => updateDirty());
  $("new-quote").addEventListener("click", newQuote);
  $("download-quote-pdf").addEventListener("click", downloadQuotePdf);
  $("save-project").addEventListener("click", () => saveProject(true));
  $("save-current-project").addEventListener("click", () => saveProject(false));
  $("load-project").addEventListener("click", openNativeProject);
  $("project-import-file").addEventListener("change", loadProject);
  $("edit-project-details").addEventListener("click", () => { selectEstimator("estimate"); showView("estimate"); $("project-no").focus(); });
  $("refresh-quotes").addEventListener("click", () => loadProjects({ refresh: true, offset: 0 }));
  $("project-search").addEventListener("input", () => {
    clearTimeout(state.projectsTimer); ++state.projectsRevision;
    state.projectsTimer = setTimeout(() => loadProjects({ offset: 0 }), 250);
  });
  $("project-sort").addEventListener("change", () => loadProjects({ offset: 0 }));
  $("project-previous").addEventListener("click", () => loadProjects({ offset: Math.max(0, state.projectsOffset - 100) }));
  $("project-next").addEventListener("click", () => loadProjects({ offset: state.projectsOffset + 100 }));
  $("project-continue").addEventListener("click", () => loadProjects());
  $("link-project-folder").addEventListener("click", linkProjectFolder);
  $("use-current-pricing").addEventListener("click", useCurrentPricing);
  $("pricing-scope").addEventListener("change", () => switchPricingScope($("pricing-scope").value));
  $("pricing-search").addEventListener("input", renderPricing);
  $("rate-group").addEventListener("change", renderPricing);
  $("show-rate-overrides").addEventListener("change", renderPricing);
  $("save-pricing").addEventListener("click", savePricing);
  $("reset-pricing").addEventListener("click", resetPricingLibrary);
  $("export-pricing").addEventListener("click", exportPricing);
  $("import-pricing").addEventListener("click", () => $("pricing-import-file").click());
  $("pricing-import-file").addEventListener("change", importPricing);
  $("discard-pricing").addEventListener("click", async () => {
    document.activeElement?.blur?.();
    const draft = state.draft, revision = state.pricingRevision;
    if (state.pricingDirty && !await confirmReplace("Discard pricing changes?", state.pricingScope === "project" ? "Project pricing edits will return to the last applied project prices." : "Shared library edits will return to the last saved library.", "Discard changes")) return;
    if (draft !== state.draft || revision !== state.pricingRevision) return;
    state.draft = clone(pricingBaseline()); refreshPricingCatalog(); renderPricing(); message("Unsaved pricing changes discarded.");
  });
  window.addEventListener("beforeunload", (event) => { if (projectHasChanges() || draftChanged(state.pricingScope === "library" ? state.draft : state.libraryDraft, state.configuration) || window.CeasefireLibraryEditor?.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; } });
  function scheduleChanged() {
    const stamp = window.CeasefirePenetrations?.quoteFingerprint?.();
    if (stamp === state.firestoppingStamp) return;
    const hadSchedule = state.firestoppingStamp !== undefined;
    state.firestoppingStamp = stamp;
    if (state.initialized) { if (hadSchedule) updateDirty(); scheduleCalculation(); }
  }
  window.CeasefireProject = { details: quoteDetails, changed: updateProjectStatus, scheduleChanged,
    configuration: () => clone(state.quoteConfiguration || state.configuration),
    downloadTarget: () => ({ project_token: state.projectFile?.save_token || null }) };
  window.CeasefireLibraryNavigation = { open: selectLibrary };
  window.CeasefirePenetrationNavigation = {
    show() { state.estimatorKind = "penetration"; return showView("estimate"); },
    showSchedule() { state.estimatorKind = "estimate"; return showView("estimate"); },
    confirm: confirmReplace,
  };
  window.CeasefireLibraryEditorNavigation = {
    show() { document.activeElement?.blur?.(); state.estimatorKind = "penetration"; showView("estimate"); },
    returnToLibrary(id) { state.libraryKind = "penetration"; showView("pricing", id); },
  };
  bootstrap();
})();
