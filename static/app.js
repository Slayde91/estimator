"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    fields: [], currentFields: [], inputs: {}, catalog: { inventory: [], rate_groups: {} }, baseline: { inventory: [], rate_groups: {} },
    configuration: { inventory: {}, rates: {} }, draft: { inventory: {}, rates: {} },
    quote: null, quoteConfiguration: null, quoteContext: 0, quoteLoadRevision: 0, dirty: false, pricingDirty: false,
    result: null, revision: 0, timer: null, controller: null, pricingView: "inventory",
  };
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const quantity = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 8 });
  const percentCells = new Set(["B9", "B26", "B27", ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
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
      control.type = field.type === "number" ? "number" : "text";
      const value = state.inputs[field.cell] ?? "";
      control.value = isPercent(field) && isNumber(value) ? shiftDecimal(value, 2) : value;
      if (control.type === "number") {
        control.step = "any";
        control.inputMode = "decimal";
      }
    }
    control.id = `input-${field.cell}`;
    control.dataset.cell = field.cell;
    control.setAttribute("aria-label", `${field.label || "Estimate input"}${isPercent(field) ? " in percent" : ""}`);
    control.addEventListener("input", () => {
      let value = control.value;
      if (field.type === "number" && control.validity.badInput) value = "Invalid number";
      if (field.type === "number" && value !== "") {
        const numeric = Number(isPercent(field) ? shiftDecimal(value, -2) : value);
        value = Number.isFinite(numeric) ? numeric : "Invalid number";
      }
      state.inputs[field.cell] = value;
      updateDirty();
      scheduleCalculation();
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
      if (/^[BCDE](1[5-9]|2[0-3])$/.test(field.cell)) continue;
      if (/^B([2-9]|10|12)$/.test(field.cell)) job.push(field);
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
    $("calculation-errors").hidden = true;
    for (const control of document.querySelectorAll("[data-cell]")) control.removeAttribute("aria-invalid");
  }

  function scheduleCalculation() {
    state.revision++;
    state.result = null;
    clearTimeout(state.timer);
    if (state.controller) state.controller.abort();
    clearResults("Calculating…");
    state.timer = setTimeout(() => { calculate(); }, 180);
  }

  async function calculate() {
    clearTimeout(state.timer);
    const revision = ++state.revision;
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    clearResults("Calculating…");
    try {
      const result = await request("/api/calculate", {
        method: "POST", signal: state.controller.signal,
        body: JSON.stringify({ inputs: state.inputs, configuration: state.quoteConfiguration || state.configuration }),
      });
      if (revision !== state.revision) return null;
      state.result = result;
      renderResults(result);
      return result;
    } catch (error) {
      if (error.name === "AbortError" || revision !== state.revision) return null;
      clearResults("Calculation unavailable");
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
    state.quote = null; state.quoteConfiguration = null;
    state.fields = clone(state.currentFields);
    state.inputs = Object.fromEntries(state.fields.map((field) => [field.cell, field.default ?? ""]));
    $("quote-title").value = "";
    $("workflow").selectedIndex = 0;
    $("measurements").value = "";
    $("snapshot-message").hidden = true;
    renderInputs(); updateDirty(false); message(""); showView("estimate"); scheduleCalculation();
  }

  async function saveQuote() {
    const title = $("quote-title").value.trim();
    if (!title) { message("Give this quote a name before saving.", true); $("quote-title").focus(); return; }
    const button = $("save-quote"); button.disabled = true;
    try {
      const inputs = clone(state.inputs);
      const workflow = $("workflow").value;
      const measurements = $("measurements").value;
      const configuration = clone(state.quoteConfiguration || state.configuration);
      const quoteContext = state.quoteContext;
      const payload = { title, inputs, workflow, measurements, configuration };
      const saved = await request(state.quote ? `/api/quotes/${encodeURIComponent(state.quote.id)}` : "/api/quotes", { method: state.quote ? "PUT" : "POST", body: JSON.stringify(payload) });
      if (quoteContext !== state.quoteContext) { message(`Saved “${title}”. Your currently open estimate has been kept.`); return; }
      const pricingChangedDuringSave = JSON.stringify(state.quoteConfiguration || state.configuration) !== JSON.stringify(configuration);
      state.quote = saved;
      if (!pricingChangedDuringSave) state.quoteConfiguration = clone(saved.configuration || configuration);
      if (!pricingChangedDuringSave && saved.fields) { state.fields = clone(saved.fields); renderInputs(); }
      $("snapshot-message").hidden = false;
      if (!pricingChangedDuringSave) $("snapshot-message").querySelector("span").textContent = "This quote uses its saved pricing snapshot.";
      const changedDuringSave = pricingChangedDuringSave || JSON.stringify(state.inputs) !== JSON.stringify(inputs) || $("quote-title").value.trim() !== title || $("workflow").value !== workflow || $("measurements").value !== measurements;
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
      state.quote = quote;
      state.quoteConfiguration = clone(quote.configuration || state.configuration);
      state.fields = clone(quote.fields || state.currentFields);
      state.inputs = { ...Object.fromEntries(state.fields.map((field) => [field.cell, field.default ?? ""])), ...quote.inputs };
      $("quote-title").value = quote.title || "";
      if (quote.workflow && !Array.from($("workflow").options).some((option) => option.value === quote.workflow)) {
        const option = node("option", "", quote.workflow); option.value = quote.workflow; $("workflow").append(option);
      }
      $("workflow").value = quote.workflow || $("workflow").options[0].value;
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
    input.step = "any";
    input.dataset.priceField = key;
    const current = getOverride(kind, item.id)[key] ?? options.defaultValue ?? item[key] ?? "";
    input.value = options.percent && isNumber(current) ? shiftDecimal(current, 2) : current;
    input.setAttribute("aria-label", `${item.name}: ${options.label || key}${options.percent ? " in percent" : ""}`);
    input.addEventListener("input", () => {
      let value = input.value;
      if (!options.text && input.validity.badInput) value = "Invalid number";
      if (!options.text && value !== "") {
        const numeric = Number(options.percent ? shiftDecimal(value, -2) : value);
        value = Number.isFinite(numeric) ? numeric : "Invalid number";
      }
      setOverride(kind, item, key, value);
      const row = input.closest("tr");
      row.classList.toggle("edited", !!state.draft[kind][item.id]);
      const output = row.querySelector("[data-sell-preview]");
      if (output) output.textContent = formatMoney(inventorySellPrice(item));
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
    const options = Object.keys(state.catalog.rate_groups || {}).map((key) => {
      const option = node("option", "", groups[key] || key); option.value = key; return option;
    });
    $("rate-group").replaceChildren(...options);
    if (options.some((option) => option.value === selection)) $("rate-group").value = selection;
  }

  function resetButton(kind, item) {
    const button = node("button", "reset-button", "Reset row");
    button.type = "button";
    button.setAttribute("aria-label", `Restore imported values for ${item.name}`);
    button.addEventListener("click", () => { delete state.draft[kind][item.id]; markPricingDirty(); renderPricing(); });
    return button;
  }

  function renderPricing() {
    const inventoryView = state.pricingView === "inventory";
    $("pricing-body").closest("table").classList.toggle("rates-table", !inventoryView);
    $("inventory-tab").classList.toggle("active", inventoryView);
    $("rates-tab").classList.toggle("active", !inventoryView);
    $("inventory-tab").setAttribute("aria-pressed", String(inventoryView));
    $("rates-tab").setAttribute("aria-pressed", String(!inventoryView));
    $("rate-group-field").hidden = inventoryView;
    const search = $("pricing-search").value.trim().toLocaleLowerCase();
    const records = inventoryView ? state.catalog.inventory || [] : state.catalog.rate_groups?.[$("rate-group").value] || [];
    const kind = inventoryView ? "inventory" : "rates";
    const matches = records.filter((item) => `${item.name} ${item.item_code || ""} ${getOverride(kind, item.id).name || ""}`.toLocaleLowerCase().includes(search));
    $("pricing-count").textContent = `${matches.length} of ${records.length} ${inventoryView ? "inventory items" : "rates"}`;
    $("pricing-help").textContent = inventoryView
      ? "Changing supplier price or markup recalculates the sell price. Items without a supplier calculation have an editable manual sell price. Reset a row to restore its imported values."
      : "An explicit rate overrides linked inventory pricing. Reset the row to restore its imported rate. Yield is the material coverage per unit.";
    const heading = node("tr");
    for (const title of inventoryView ? ["Item code", "Product", "Supplier price", "Markup %", "Sell price", ""] : ["Rate / product", "Sell rate", "Yield", ""]) heading.append(node("th", "", title));
    $("pricing-head").replaceChildren(heading);
    const rows = matches.map((item) => {
      const row = node("tr", state.draft[kind]?.[item.id] ? "edited" : "");
      row.dataset.priceId = item.id;
      if (inventoryView) row.append(node("td", "", item.item_code || "—"));
      const nameCell = node("td");
      if (inventoryView) nameCell.append(priceInput(kind, item, "name", { text: true, label: "Name" }));
      else nameCell.append(node("span", "", item.name));
      const detail = inventoryView ? (item.pricing_mode === "manual" ? "Manual sell price" : "Supplier price and markup") : groups[$("rate-group").value] || $("rate-group").value;
      nameCell.append(node("small", "subtext", detail));
      row.append(nameCell);
      if (inventoryView) {
        const supplier = node("td");
        const markup = node("td");
        if (item.pricing_mode === "manual") {
          supplier.textContent = formatMoney(item.supplier_price);
          markup.textContent = "—";
        } else {
          supplier.append(priceInput(kind, item, "supplier_price", { label: "Supplier price" }));
          markup.append(priceInput(kind, item, "markup", { percent: true, label: "Markup" }));
        }
        const sell = node("td");
        if (item.pricing_mode === "manual") sell.append(priceInput(kind, item, "sales_price", { label: "Manual sell price" }));
        else { const output = node("span", "price-value", formatMoney(inventorySellPrice(item))); output.dataset.sellPreview = "true"; sell.append(output); }
        row.append(supplier, markup, sell);
      } else {
        const price = node("td"); price.append(priceInput(kind, item, "price", { label: "Sell rate", defaultValue: rateSellPrice(item) }));
        const yieldCell = node("td");
        if (item.uses_yield ?? !!item.source?.yield) yieldCell.append(priceInput(kind, item, "yield", { label: "Material yield" }));
        else yieldCell.textContent = "—";
        row.append(price, yieldCell);
      }
      const reset = node("td"); reset.append(resetButton(kind, item)); row.append(reset);
      return row;
    });
    if (!rows.length) { const row = node("tr"); const cell = node("td", "empty-state", "No matching products or rates."); cell.colSpan = inventoryView ? 6 : 4; row.append(cell); rows.push(row); }
    $("pricing-body").replaceChildren(...rows);
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
        $("workflow").replaceChildren(...data.workflows.map((workflow) => { const option = node("option", "", workflow); option.value = workflow; return option; }));
      }
      refreshPricingCatalog();
      $("loading-state").hidden = true;
      await newQuote();
    } catch (error) { $("loading-state").textContent = "The estimator could not be loaded. Reload after the local server is available."; message(error.message, true); }
  }

  async function printQuote() {
    const button = $("print-quote"); button.disabled = true;
    try {
      const result = await calculate();
      if (!result) { message("The estimate changed or could not be calculated. Check the inputs and print again.", true); return; }
      showView("estimate");
      window.print();
    } finally { button.disabled = false; }
  }

  function reportPayload() {
    return {
      title: $("quote-title").value.trim(),
      inputs: clone(state.inputs),
      configuration: clone(state.quoteConfiguration || state.configuration),
      workflow: $("workflow").value,
      measurements: $("measurements").value,
      ...(state.quote ? { source_quote_id: state.quote.id } : {}),
    };
  }

  function reportFilename(disposition) {
    const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition || "");
    const filename = (match?.[1] ?? match?.[2] ?? "").trim();
    // The server supplies an ASCII slug. Ignore paths or unexpected filenames.
    return /^[a-z0-9][a-z0-9._-]{0,180}\.pdf$/i.test(filename) ? filename : "ceasefire-quote.pdf";
  }

  async function downloadQuotePdf() {
    const button = $("download-quote-pdf");
    if (button.disabled) return;
    const payload = reportPayload();
    if (!payload.title) { message("Give this quote a name before downloading its PDF.", true); $("quote-title").focus(); return; }
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
  for (const id of ["quote-title", "workflow", "measurements"]) $(id).addEventListener("input", () => updateDirty());
  $("new-quote").addEventListener("click", newQuote);
  $("save-quote").addEventListener("click", saveQuote);
  $("print-quote").addEventListener("click", printQuote);
  $("download-quote-pdf").addEventListener("click", downloadQuotePdf);
  $("refresh-quotes").addEventListener("click", loadQuotes);
  $("use-current-pricing").addEventListener("click", () => { state.quoteConfiguration = clone(state.configuration); state.fields = clone(state.currentFields); renderInputs(); $("snapshot-message").querySelector("span").textContent = "Current pricing applied. Save to replace this quote's pricing snapshot."; updateDirty(); scheduleCalculation(); message("Current pricing applied to this estimate. Check any removed product selections, then save the quote to retain its new pricing snapshot."); });
  $("inventory-tab").addEventListener("click", () => { state.pricingView = "inventory"; renderPricing(); });
  $("rates-tab").addEventListener("click", () => { state.pricingView = "rates"; renderPricing(); });
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
  bootstrap();
})();
