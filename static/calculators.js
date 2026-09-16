"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const state = { list: null, entries: new Map(), current: null, loadRevision: 0, requestRevision: 0, timer: null, action: false, optionLists: new Map(), optionKeys: new WeakMap(), nextListId: 0 };
  const descriptions = {
    steel_vermiculite: "Steel schedules, coating thicknesses and material quantities",
    ductwork: "Ductwork dimensions, protection systems and quantities",
    steel_board: "Steel member schedules, board stacks and whole-sheet takeoff",
  };
  // Display-only wording for identified workbook directions. These are scoped
  // to their original cells; a general A1 replacement would corrupt product,
  // fastener, exposure and report identifiers such as P250, M12 and R3.
  const boardStatusDirections = [
    ["Family (K)", "Family (ESA input)"], ["Clear K to use", "Clear Family (ESA input) to use"],
    ["Thickness lookup (P)", "Thickness lookup"],
    ["An exposed depth is entered in N.", "An exposed depth is entered in Partial depth."],
    ["Exposure layout (M)", "Exposure layout"], ["or clear N.", "or clear Partial depth."],
    ["inside-box girth in V", "inside-box girth in Box girth override"],
    ["board product in C", "board product in Product"], ["Steel ID (D) or ESA/M (E)", "Steel ID or ESA/M input"],
    ["exposed sides in G", "exposed sides in Sides"],
    ["period in H, in minutes", "period in FRL required, in minutes"],
    ["Beam or Column in I", "Beam or Column in the member-type input"],
    ["temperature in J", "temperature in Critical temp"],
    ["Check E and R:V", "Check ESA/M input and the dimension, area, mass and box-girth overrides"],
    ["Layer preference (O)", "Layer preference"], ["Exposure layout in M", "Exposure layout"],
    ["a depth in N", "a Partial depth"], ["ESA/M in E", "ESA/M input"],
    ["Installation detail in Q", "Installation detail"], ["steel depth in R", "steel depth in Depth or OD"],
    ["Auto or Double in O", "Auto or Double in Layer preference"], ["Added girth (W)", "Added girth"],
    ["a total length greater than zero in F, in metres", "Lineal metres greater than zero"],
    ["depth/width (R/S) or inside-box girth (V)", "depth/width or Box girth override"],
    ["depth/width in R/S", "Depth or OD and Width B"],
    ["Check L, or the default on SETTINGS when L is blank.", "Check Waste (%), or Default wastage on SETTINGS when Waste (%) is blank."],
  ];
  const factorLookupDirections = [["the global lookup policy in D14", "the global Factor lookup policy"]];
  const estimatingDensityDirections = [["Used only when direct yield is blank.", "Used only when direct yield is blank. Estimating density means dry-material consumption per applied volume, not installed coating density."]];
  const sourceDirections = {
    ductwork: {
      CALCULATOR: {
        A3: [["Enter the schedule in blue cells.", "Enter values in the schedule input fields."], ["choose the duct use in column H", "choose the FyreWrap duct use"]],
        A5: [["see the FRL header comment for FyreWrap applications.", "review the FyreWrap application notes in PRODUCT SETTINGS."]],
        A6: [["Comments explain inputs, limits and excluded items.", "Review the input labels, calculated notes and PRODUCT SETTINGS for limits and excluded items."]],
      },
      "PRODUCT SETTINGS": {
        A4: [["CAFCO: rows 6–46 | MONOKOTE: 48–92 | FyreWrap: 94–150 | Use notes: 153–159", "CAFCO settings | MONOKOTE settings | FyreWrap settings | Use notes"]],
        E25: [["B35 selects the yield.", "Yield basis selects the yield."]],
        B43: [["Choose B35.", "Choose the CAFCO Yield basis."]],
        E65: [["separately from B73", "separately from Yield basis"], ["by B67/B66", "by the injected-to-uninjected chart-yield ratio"]],
        E67: [["The B67/B66 multiplier", "The injected-to-uninjected chart-yield multiplier"]],
        E69: [["B73 selects the base yield. B65 applies", "Yield basis selects the base yield. Injection applies"]],
        E73: [["B65 then applies", "Injection then applies"]],
        B89: [["the base at B73 and injection at B65", "Yield basis and Injection"]],
        A142: [["B30 / D30 audit", "Maximum duct-size rule audit"]],
        B146: [["S:U show report lengths.", "Wall layer 2, Floor layer 2 and Floor layer 3 show report lengths."]],
      },
    },
    steel_vermiculite: {
      CALCULATOR: { A20: [["Edit the blue cells.", "Edit the input fields."]] },
      SCHEDULE: { A3: [["filter or sort the complete table", "all rows are available on this page"]], A8: [["Paste your steel schedule here; blue cells are editable.", "Enter the schedule inputs, or use Import XLSX Schedule."]] },
      BAGS: { A27: [["The factor helper is also there.", "Open FACTOR CALCS for factor helpers."], ["Hidden reference sheets support the calculations and must not be deleted.", "Retained reference data supports the calculations."]] },
      SETTINGS: {
        A3: [["blue cells are editable", "input fields are editable"]],
        A7: [["Factor helper starts at row 341.", "Open FACTOR CALCS for the Section Factor Helper."]],
        G43: factorLookupDirections, G76: factorLookupDirections, G108: factorLookupDirections,
        G185: factorLookupDirections, G241: factorLookupDirections,
        G38: estimatingDensityDirections, G71: estimatingDensityDirections, G103: estimatingDensityDirections,
        G180: estimatingDensityDirections, G236: estimatingDensityDirections,
        BD7: [["Exact row sources are in SECTIONS AB:AC", "Exact row sources are retained in the steel-section source records"]],
        BD27: [["SECTIONS!A571:AV970 retains", "The retained steel-section reference data includes"]],
        D79: [["Source links: T330 and V330.", "See the Mandolite yield-source links on SETTINGS."]],
        D111: [["Source links: T331 and V331.", "See the Fendolite yield-source links on SETTINGS."]],
        D188: [["Source links: T332 and V332.", "See the Perlifoc yield-source links on SETTINGS."]],
        D244: [["Source links: T333 and V333.", "See the Monokote yield-source links on SETTINGS."]],
        A301: [["CAFCO uses an inherited assumption;", "The original CAFCO workbook used an inherited assumption; reviewed defaults use Australian published coverage;"], ["Sources: P330:V333.", "See the product yield-source records on SETTINGS."]],
        A293: [["Sort or filter the entire SCHEDULE table, never one column alone.", "The complete SCHEDULE table stays together on one page."]],
      },
    },
    steel_board: {
      START: {
        A10: [["NORMAL INPUTS A:L", "NORMAL INPUTS"]], A11: [["MAIN RESULTS Y:AI", "MAIN RESULTS"]],
        D9: [["200 prepared rows: 9–208.", "200 prepared schedule items."]],
        D11: [["Row status (AI)", "Row status"], ["AD is reference box area only; AE/AF are actual board quantities.", "Box reference area is for reference only; Board required - net and Board incl waste are actual board quantities."]],
        D13: [["This hidden input sheet", "The EXTRA BOARDS page"], ["Right-click a sheet tab and choose Unhide to enter them.", "Open EXTRA BOARDS to enter them."]],
        A16: [["AD is a reference area", "Box reference area is a reference area"]],
        A17: [["AE adds the layer areas.", "Board required - net adds the layer areas."]],
        A19: [["V is an INSIDE BOX GIRTH", "Box girth override is an INSIDE BOX GIRTH"], ["W is an extra inside-girth allowance", "Added girth is an extra inside-girth allowance"]],
        A26: [["Unhide M:X for advanced inputs. M:Q controls layout, layers, lookup and installation detail. R/S = depth/width; T = area; U = mass; V = INSIDE box girth; W = added girth; X = design reference. AI gives the action directly. AJ:AV retains detailed outputs and notes.", "Row status gives the required action. Saved optional inputs, detailed calculation outputs and notes remain part of the workbook rules."]],
        A27: [["Only START, CALCULATOR and BOARD SUMMARY are visible. Supporting data sheets remain embedded and hidden. Do not delete them.", "Use START, CALCULATOR, BOARD SUMMARY, EXTRA BOARDS and SETTINGS. Supporting reference data is retained by the application."]],
        A28: [["For a larger job, extend inside the table, copy ALL formula columns Y:CI and check dropdowns and purchasing ranges. Do not assume typing below row 208 automatically extends every summary formula.", "Larger schedules require extending the supported calculation range and checking every dropdown and purchasing total. Items beyond this capacity are not included automatically."]],
        A31: [["on the hidden EXTRA BOARDS sheet", "on the EXTRA BOARDS page"]],
      },
      CALCULATOR: {
        A5: [["Paste into A:L only.", "Enter the normal schedule inputs."]],
        A6: [["Only START, CALCULATOR and BOARD SUMMARY are visible. See START for optional columns and hidden supporting sheets.", "Use START for guidance, EXTRA BOARDS for additional allowances, and SETTINGS for configuration."]],
        Y2: [["AD = reference box only  |  AE = all board layers, net  |  AF = board including wastage", "Box reference area is for reference only  |  Board required - net includes all layers  |  Board incl waste includes wastage"]],
        Y5: [["AI gives the issue and action directly.", "Row status gives the issue and action directly."]],
        Y6: [["their notes in AI", "their Row status notes"]],
      },
      SETTINGS: { A3: [["Blue wastage", "The wastage setting"]] },
      "BOARD SUMMARY": {
        A8: [["CALCULATOR column AI", "CALCULATOR Row status"], ["on hidden EXTRA BOARDS", "on EXTRA BOARDS"]],
        A35: [["CALCULATOR column AD", "the CALCULATOR Box reference area"]],
      },
    },
  };
  const current = () => state.entries.get(state.current);
  const endpoint = (id, action = "") => `/api/calculators/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const dirty = (entry) => JSON.stringify(entry.inputs) !== entry.saved;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function message(text = "", error = false) {
    const box = $("calculator-message");
    box.textContent = text; box.hidden = !text;
    box.className = `message${error ? " error" : ""}`;
    box.setAttribute("role", error ? "alert" : "status");
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function columnName(value) {
    let name = "";
    for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }

  function parseAddress(value) {
    const match = String(value).match(/^\$?([A-Z]+)\$?(\d+)$/i);
    if (!match) return null;
    return { column: [...match[1].toUpperCase()].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0), row: Number(match[2]) };
  }

  function columnNumber(value) {
    return typeof value === "number" || /^\d+$/.test(value) ? Number(value) : parseAddress(`${value}1`)?.column;
  }

  function decimalShift(value, places) {
    const parts = String(value).toLowerCase().split("e");
    return Number(`${parts[0]}e${Number(parts[1] || 0) + places}`);
  }

  function percent(cell) { return String(cell.number_format || "").includes("%"); }
  function displayValue(value, cell = {}, editing = false) {
    if (value === null || value === undefined || value === "") return "";
    if (!isNumber(value)) return String(value);
    const visible = percent(cell) ? decimalShift(value, 2) : value;
    if (editing) return String(visible);
    return `${number.format(visible)}${percent(cell) ? "%" : ""}`;
  }

  function numericInputValue(value, cell, editing = false) {
    if (!isNumber(value)) return value ?? "";
    const visible = percent(cell) ? decimalShift(value, 2) : value;
    return editing ? String(visible) : controlNumber.format(visible);
  }

  function sheetMetadata(entry) { return entry.definition.sheets.find((sheet) => sheet.name === entry.sheet) || {}; }
  function displayPages(definition) {
    return definition.display_pages?.length ? definition.display_pages : definition.pages.map((sheet) => ({ id: sheet, label: sheet, sheet }));
  }
  function currentPage(entry) { return entry.page || entry.sheet; }
  function pageDefinition(entry) { return displayPages(entry.definition).find((page) => page.id === currentPage(entry)) || { id: currentPage(entry), label: currentPage(entry), sheet: entry.sheet }; }
  function hiddenColumns(metadata) {
    const hidden = new Set(metadata.hidden_columns || []);
    for (const [column, width] of Object.entries(metadata.column_widths || {})) if (Number.isFinite(Number(width)) && Number(width) <= 0) hidden.add(columnNumber(column));
    return hidden;
  }

  function sourceDisplayText(value, entry, address, result = entry?.result) {
    if (!entry) return value;
    const overrides = result?.display_text || sheetMetadata(entry).display_text || {};
    if (Object.prototype.hasOwnProperty.call(overrides, address) && typeof overrides[address] === "string") return overrides[address];
    if (typeof value !== "string") return value;
    if (["SETTINGS", "PRODUCT SETTINGS"].includes(entry.sheet) && address === "A1") return "SETTINGS & RULES";
    const id = entry.definition.id;
    let replacements = sourceDirections[id]?.[entry.sheet]?.[address] || [];
    const position = parseAddress(address);
    const schedule = entry.definition.schedule;
    if (id === "steel_board" && position && ((entry.sheet === schedule?.sheet && position.column === 35 && position.row >= schedule.first_row && position.row <= schedule.last_row) || (entry.sheet === "SETTINGS" && position.column === 17 && position.row >= 6 && position.row <= 51))) replacements = boardStatusDirections;
    return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
  }
  function updateStatus(entry = current()) {
    if (!entry || entry !== current()) return;
    $("calculator-save-status").textContent = dirty(entry) ? "Unsaved calculator changes · use Save Project" : "Project calculator inputs · use Save Project to save all calculators";
    const hasErrors = entry.invalid.size > 0;
    $("calculator-recalculate").disabled = hasErrors;
    $("calculator-pdf").disabled = state.action || hasErrors;
    $("calculator-excel").disabled = state.action || hasErrors;
    $("calculator-summary-pdf").disabled = state.action || hasErrors;
    if (hasErrors) calculationStatus("Enter a valid number to recalculate.");
    $("calculator-reset").disabled = state.action;
    $("calculator-import").disabled = state.action;
    $("calculator-template").disabled = state.action;
  }

  function calculationStatus(text = "") {
    const status = $("calculator-calculation-status"); status.textContent = text; status.hidden = !text;
  }

  function setInput(entry, sheet, address, value) {
    entry.inputs[sheet] ||= {};
    entry.inputs[sheet][address] = value;
    entry.pendingResult = null;
    entry.revision++;
    updateStatus(entry);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (entry === current()) calculate(); }, 550);
  }

  function cellOptions(cell, entry) {
    return Array.isArray(cell.options) ? cell.options : entry.result?.option_sets?.[cell.options_ref] || [];
  }

  function sharedOptionList(options, cell) {
    let key = state.optionKeys.get(options);
    if (!key) { key = JSON.stringify(options); state.optionKeys.set(options, key); }
    key = `${percent(cell) ? "percent:" : "value:"}${key}`;
    if (state.optionLists.has(key)) return state.optionLists.get(key);
    const list = node("datalist"); list.id = `calculator-shared-options-${++state.nextListId}`;
    for (const item of options) { const option = node("option"); option.value = isNumber(item) ? numericInputValue(item, cell, true) : String(item); list.append(option); }
    $("calculator-option-lists").append(list); state.optionLists.set(key, list.id); return list.id;
  }

  function makeControl(cell, row, entry, label) {
    const address = cell.address || `${columnName(cell.column)}${row}`;
    const key = `${entry.sheet}!${address}`;
    const sourceSheet = entry.sheet;
    const rawValue = () => {
      const latest = entry.latestCells?.get(key);
      return Object.prototype.hasOwnProperty.call(entry.inputs[sourceSheet] || {}, address) ? entry.inputs[sourceSheet][address] : latest ? latest.value : cell.value;
    };
    const value = rawValue();
    const options = cellOptions(cell, entry);
    const allowOther = cell.allow_other || ["warning", "information"].includes(cell.error_style || cell.validation?.error_style || cell.validation?.errorStyle);
    // A dropdown may mix numbers and text (60 and "60/60/60"). Its current
    // selection cannot determine the type of every other available option.
    const numeric = cell.type === "number" || (cell.type === "select" && options.length > 0 && options.every(isNumber)) || (cell.type !== "select" && isNumber(value) && cell.type !== "text");
    const numericOptions = options.some(isNumber);
    const display = (entry.result?.display_cells || sheetMetadata(entry).display_cells || {})[address];
    const select = cell.type === "select" && (display?.control === "select" || !allowOther && options.length <= 40);
    const customAllowed = select && allowOther;
    const multiline = Boolean(cell.multiline);
    const control = node(select ? "select" : multiline ? "textarea" : "input", numeric ? "calculator-number" : "");
    const custom = customAllowed ? node("input", numeric ? "calculator-number" : "") : null;
    let customMode = false, customToken = "__calculator_custom_value__", customOption;
    while (options.some((option) => String(option) === customToken) || String(value) === customToken) customToken += "_";
    if (custom) {
      custom.type = "text"; custom.hidden = true; custom.autocomplete = "off";
      custom.dataset.calculatorCustomCell = address; custom.dataset.calculatorSheet = sourceSheet;
      custom.setAttribute("aria-label", `${label} custom value${percent(cell) ? " in percent" : ""}`);
      if (numeric) custom.inputMode = "decimal";
      customOption = node("option", "", "Enter custom value…"); customOption.value = customToken;
    }
    const selectOptions = [];
    control.dataset.calculatorCell = address;
    control.dataset.calculatorSheet = entry.sheet;
    control.setAttribute("aria-label", `${label}${percent(cell) ? " in percent" : ""}`);
    if (select) {
      const appendOption = (item) => {
        const option = node("option", "", item === "" ? "(blank)" : displayValue(item, cell));
        option.value = String(item); control.append(option); selectOptions.push({ option, value: item });
        if (isNumber(item)) option.title = `Exact value: ${numericInputValue(item, cell, true)}${percent(cell) ? "%" : ""}`;
      };
      control.calculatorEnsureOption = (item) => {
        item ??= "";
        if (custom && String(item) === customToken) {
          do { customToken += "_"; } while (options.some((option) => String(option) === customToken) || String(item) === customToken);
          customOption.value = customToken; if (customMode) control.value = customToken;
        }
        if (!selectOptions.some(({ value: existing }) => String(existing) === String(item))) appendOption(item);
      };
      const deferredOptions = options.length > 40;
      let optionsLoaded = !deferredOptions;
      const populate = () => {
        if (optionsLoaded) return;
        const selected = rawValue();
        control.replaceChildren(); selectOptions.length = 0;
        appendOption("");
        for (const item of options) if (String(item) !== "") appendOption(item);
        control.calculatorEnsureOption(selected);
        if (custom) control.append(customOption);
        control.value = customMode ? customToken : String(selected ?? ""); optionsLoaded = true;
      };
      appendOption("");
      for (const item of deferredOptions ? [] : options) if (String(item) !== "") appendOption(item);
      control.calculatorEnsureOption(value);
      if (custom) control.append(customOption);
      // A thousand prepared rows can share a large strict choice list. Keep
      // native selects lightweight until their first pointer/keyboard opening.
      if (deferredOptions) for (const event of ["pointerdown", "focus", "keydown"]) control.addEventListener(event, populate);
      control.value = String(value ?? "");
    } else {
      if (multiline) { control.rows = 4; control.classList.add("calculator-basis-input"); }
      else control.type = "text";
      control.value = numeric || isNumber(value) ? numericInputValue(value, cell) : value ?? "";
      if (numeric) control.inputMode = "decimal";
      control.autocomplete = "off";
    }
    if (isNumber(value)) control.title = `Exact value: ${numericInputValue(value, cell, true)}${percent(cell) ? "%" : ""}`;
    if (entry.invalid.has(key)) { control.value = entry.invalid.get(key); control.setAttribute("aria-invalid", "true"); }
    const bindEditor = (editor, isChoice) => {
      let focusedValue;
      editor.addEventListener("focus", () => {
        for (const item of selectOptions) if (isNumber(item.value)) item.option.textContent = `${numericInputValue(item.value, cell, true)}${percent(cell) ? "%" : ""}`;
        if (!isChoice && !entry.invalid.has(key)) {
          const raw = rawValue();
          if (numeric || isNumber(raw)) { editor.value = numericInputValue(raw, cell, true); editor.select(); }
        }
        focusedValue = editor.value;
      });
      editor.addEventListener(isChoice ? "change" : "input", () => {
        if (isChoice && custom && editor.value === customToken) {
          customMode = true; custom.hidden = false;
          custom.value = entry.invalid.has(key) ? entry.invalid.get(key) : numericInputValue(rawValue(), cell, true);
          custom.focus?.(); return;
        }
        if (isChoice && custom) { customMode = false; custom.hidden = true; }
        let next = editor.value;
        const optionText = (option) => String(!isChoice && isNumber(option) && percent(cell) ? decimalShift(option, 2) : option);
        const optionIndex = options.findIndex((option) => optionText(option) === next);
        const selectedOption = isChoice ? selectOptions.find(({ option }) => option.value === next) : null;
        const validSyntax = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(next.trim());
        if (selectedOption) next = selectedOption.value;
        else if (optionIndex >= 0) next = options[optionIndex];
        else if ((numeric || (numericOptions && validSyntax)) && next !== "") {
          next = validSyntax ? Number(next) : NaN;
          if (!Number.isFinite(next)) {
            entry.invalid.set(key, editor.value); editor.setAttribute("aria-invalid", "true"); control.setAttribute("aria-invalid", "true");
            entry.revision++; entry.pendingResult = null; clearTimeout(state.timer); updateStatus(entry);
            calculationStatus("Enter a valid number to recalculate."); return;
          }
          if (percent(cell)) next = decimalShift(next, -2);
        }
        entry.invalid.delete(key); control.removeAttribute("aria-invalid"); custom?.removeAttribute("aria-invalid");
        if (isNumber(next)) editor.title = `Exact value: ${numericInputValue(next, cell, true)}${percent(cell) ? "%" : ""}`;
        else editor.removeAttribute("title");
        setInput(entry, sourceSheet, address, next);
      });
      editor.addEventListener("blur", (event) => {
        const selectedValue = Object.prototype.hasOwnProperty.call(entry.inputs[sourceSheet] || {}, address) ? entry.inputs[sourceSheet][address] : value;
        if (!isChoice && cell.type === "select" && !allowOther && selectedValue !== null && selectedValue !== "" && !options.some((option) => String(option) === String(selectedValue)) && String(value ?? "") !== String(selectedValue)) {
          entry.invalid.set(key, editor.value); editor.setAttribute("aria-invalid", "true");
          calculationStatus("Choose a value from the available list."); updateStatus(entry);
        }
        for (const item of selectOptions) if (isNumber(item.value)) item.option.textContent = displayValue(item.value, cell);
        if (!isChoice && !entry.invalid.has(key)) {
          const raw = rawValue(); if (numeric || isNumber(raw)) editor.value = numericInputValue(raw, cell);
        }
        const target = event?.relatedTarget, choosingSettings = target?.dataset?.calculatorSettingsSection !== undefined;
        const sameField = target?.dataset?.calculatorSheet === sourceSheet && (target.dataset.calculatorCell === address || target.dataset.calculatorCustomCell === address);
        if (focusedValue !== undefined && entry.pendingResult && !entry.invalid.size && !choosingSettings && !sameField) {
          entry.result = entry.pendingResult; entry.pendingResult = null; renderGrid(entry);
        }
      });
    };
    bindEditor(control, select);
    if (custom) {
      bindEditor(custom, false);
      control.calculatorSyncValue = (next) => {
        control.calculatorEnsureOption(next);
        control.value = customMode ? customToken : String(next ?? "");
        if (customMode && custom !== document.activeElement && !entry.invalid.has(key)) custom.value = numericInputValue(next, cell);
      };
      if (entry.invalid.has(key)) {
        customMode = true; custom.hidden = false; custom.value = entry.invalid.get(key);
        custom.setAttribute("aria-invalid", "true"); control.value = customToken;
      }
      const wrapper = node("div", "calculator-native-custom"); wrapper.append(control, custom); return wrapper;
    }
    if (!select && options.length) {
      control.setAttribute("list", sharedOptionList(options, cell));
      const wrapper = node("div"); wrapper.append(control); return wrapper;
    }
    return control;
  }

  function headerLabels(entry, result) {
    const metadata = sheetMetadata(entry);
    const labels = { ...(metadata.column_labels || {}), ...(entry.labels[entry.sheet] || {}) };
    const headerRows = new Set(metadata.header_rows || []);
    if (entry.definition.schedule?.sheet === entry.sheet) headerRows.add(entry.definition.schedule.header_row);
    for (const column of Array.isArray(metadata.columns) ? metadata.columns : []) if (column.label) labels[columnNumber(column.column)] = column.label;
    for (const column of entry.definition.schedule?.sheet === entry.sheet ? entry.definition.schedule.columns || [] : []) if (column.label) labels[columnNumber(column.column)] = column.label;
    for (const row of result.rows || []) if (headerRows.has(row.row)) {
      for (const cell of row.cells) if (cell.value !== null && cell.value !== "" && !cell.editable) labels[cell.column] = String(sourceDisplayText(cell.value, entry, cell.address || `${columnName(cell.column)}${row.row}`, result));
    }
    entry.labels[entry.sheet] = labels;
    return labels;
  }

  function updateOutputCell(element, cell) {
    const address = cell.address || element.dataset.calculatorOutput, entry = current();
    const value = sourceDisplayText(cell.value, entry, address), suffix = entry && (entry.result?.display_cells || sheetMetadata(entry).display_cells)?.[address]?.suffix;
    const schedule = entry?.definition.schedule, position = parseAddress(address);
    const lineNumber = schedule && entry.sheet === schedule.sheet && position?.column === columnNumber(schedule.line_id_column) && position.row >= schedule.first_row && position.row <= schedule.last_row;
    element.textContent = (lineNumber && Number.isInteger(value) ? String(value) : displayValue(value, cell)) + (isNumber(value) && !cell.error && typeof suffix === "string" ? suffix : "");
    if (entry?.definition.id === "steel_vermiculite" && entry.sheet === "SETTINGS" && ["J32", "J65", "J97", "J174", "J230"].includes(address) && cell.value === "BACK TO TOP") {
      const link = node("a", "calculator-inline-link", "Back to worksheet controls"); link.href = "#calculator-sheet-title"; element.replaceChildren(link);
    }
    element.classList.toggle("calculator-number", isNumber(cell.value));
    element.classList.toggle("calculator-error", Boolean(cell.error) || (typeof cell.value === "string" && /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|CALC!)/.test(cell.value)));
    const highlight = entry && (entry.result?.display_cells || sheetMetadata(entry).display_cells)?.[address]?.highlight;
    element.classList.toggle("calculator-published-thickness", highlight === "published-thickness" && isNumber(cell.value) && !cell.error);
    element.classList.toggle("calculator-row-status", Boolean(entry?.definition.id === "steel_board" && entry.sheet === schedule?.sheet && position?.column === 35 && position.row >= schedule.first_row && position.row <= schedule.last_row));
    if (element.dataset.calculatorValue === "true") {
      outputState(element, cell.value);
      if (element.calculatorValueCard) outputState(element.calculatorValueCard, cell.value);
    }
  }

  function outputState(element, value) {
    const present = value !== null && value !== undefined && value !== "";
    element.classList.toggle("calculator-value-present", present);
    element.classList.toggle("calculator-value-empty", !present);
  }

  function displayMetadata(entry, result = entry.result) {
    const metadata = sheetMetadata(entry);
    return { ...metadata, omitted_rows: result?.omitted_rows || metadata.omitted_rows || [], omitted_columns: result?.omitted_columns || metadata.omitted_columns || [], omitted_ranges: result?.omitted_ranges || metadata.omitted_ranges || [], presentation_tables: result?.presentation_tables || metadata.presentation_tables || [], table_layout: result?.table_layout || metadata.table_layout, display_column_order: result?.display_column_order || metadata.display_column_order || [], display_text: result?.display_text || metadata.display_text || {}, display_cells: result?.display_cells || metadata.display_cells || {}, navigation_mode: result?.navigation_mode ?? metadata.navigation_mode ?? "links", settings_sections: result?.settings_sections ?? metadata.settings_sections ?? [], display_table_order: result?.display_table_order ?? metadata.display_table_order ?? [], schedule_heading: result?.schedule_heading ?? metadata.schedule_heading ?? "", expand_tables: result?.expand_tables ?? metadata.expand_tables ?? false };
  }

  function omittedCell(metadata) {
    const ranges = (metadata.omitted_ranges || []).map((range) => {
      const [start, end] = range.split(":").map(parseAddress);
      return start ? { start, end: end || start } : null;
    }).filter(Boolean);
    return (row, column) => ranges.some(({ start, end }) => row >= start.row && row <= end.row && column >= start.column && column <= end.column);
  }

  function refreshOutputs(result) {
    const cells = new Map(result.rows.flatMap((row) => row.cells.map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell])));
    for (const element of $("calculator-grid").querySelectorAll("[data-calculator-output]")) {
      const cell = cells.get(element.dataset.calculatorOutput);
      if (cell) updateOutputCell(element, cell);
    }
    const entry = current();
    for (const control of $("calculator-grid").querySelectorAll("[data-calculator-cell]")) {
      const address = control.dataset.calculatorCell, key = `${entry.sheet}!${address}`, cell = cells.get(address);
      if (!cell || control === document.activeElement || entry.invalid.has(key)) continue;
      const value = Object.prototype.hasOwnProperty.call(entry.inputs[entry.sheet] || {}, address) ? entry.inputs[entry.sheet][address] : cell.value;
      if (control.calculatorSyncValue) control.calculatorSyncValue(value);
      else {
        control.calculatorEnsureOption?.(value);
        const shown = String(control.tagName.toLowerCase() === "select" ? value ?? "" : isNumber(value) ? numericInputValue(value, cell) : value ?? "");
        if (String(control.value) !== shown) control.value = shown;
      }
      if (isNumber(value)) control.title = `Exact value: ${numericInputValue(value, cell, true)}${percent(cell) ? "%" : ""}`;
    }
    renderProductTotals(result, entry.productTotalsElement);
  }

  function choiceSignature(result, entry = current()) {
    const schedule = entry.definition.schedule?.sheet === entry.sheet ? entry.definition.schedule : entry.sheet === "EXTRA BOARDS" ? { header_row: 5 } : null;
    const metadata = displayMetadata(entry, result), omittedRows = new Set(metadata.omitted_rows), omittedColumns = new Set(metadata.omitted_columns), isOmitted = omittedCell(metadata);
    // Forms collapse empty rows/columns. A newly populated formula or note must
    // rebuild that structure; ordinary schedule edits still retain every control.
    const rows = result.rows.filter((row) => !omittedRows.has(row.row));
    const content = rows.filter((row) => !schedule || row.row < schedule.header_row).map((row) => [row.row, row.cells.filter((cell) => !omittedColumns.has(cell.column) && !isOmitted(row.row, cell.column) && (cell.editable || (cell.value !== null && cell.value !== undefined && cell.value !== ""))).map((cell) => cell.column)]);
    const titleAddresses = new Set(metadata.presentation_tables.map((table) => table.title_address).filter(Boolean));
    const titles = rows.flatMap((row) => row.cells.filter((cell) => titleAddresses.has(cell.address || `${columnName(cell.column)}${row.row}`)).map((cell) => cell.value));
    return JSON.stringify([{ ...pageDefinition(entry), section_spacing: result.section_spacing ?? metadata.section_spacing }, result.visible_columns, metadata.omitted_rows, metadata.omitted_columns, metadata.omitted_ranges, metadata.presentation_tables, metadata.table_layout, metadata.display_column_order, metadata.display_text, metadata.display_cells, metadata.navigation_mode, metadata.settings_sections, metadata.display_table_order, metadata.schedule_heading, metadata.expand_tables, titles, content, result.option_sets || {}, rows.map((row) => row.cells.filter((cell) => cell.editable && !omittedColumns.has(cell.column) && !isOmitted(row.row, cell.column)).map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell.type, cell.options_ref || cell.options, cell.allow_other, cell.error_style, cell.validation]))]);
  }

  function presentationRole(cell) {
    return cell.presentation?.role || (cell.editable ? "input" : cell.calculated ? "output" : "body");
  }

  function referenceTableValue(entry, row, column) {
    if (entry.definition.id === "ductwork" && entry.sheet === "SUMMARY") return [[9, 11, 12], [19, 26, 6], [31, 32, 6], [40, 41, 9]].some(([first, last, endColumn]) => row >= first && row <= last && column <= endColumn);
    if (entry.definition.id === "steel_board" && entry.sheet === "BOARD SUMMARY") return row >= 12 && row <= 29 && column <= 12;
    if (entry.definition.id === "steel_board" && entry.sheet === "SETTINGS") return row >= 6 && ((row <= 12 && column >= 7 && column <= 14) || row <= 51 && column >= 16 && column <= 17);
    return false;
  }

  function applyCellDisplay(element, display = {}, sourceBold = false) {
    if (display.bold === false) element.classList.add("calculator-normal");
    else if (display.bold === true || sourceBold) element.classList.add("calculator-bold");
    if (["left", "center"].includes(display.align)) element.classList.add(`calculator-align-${display.align}`);
  }

  function renderOverview(rows, entry, columns) {
    const metadata = displayMetadata(entry), omittedRows = new Set(metadata.omitted_rows), isOmitted = omittedCell(metadata);
    rows = rows.filter((row) => !omittedRows.has(row.row)).map((row) => ({ ...row, cells: row.cells.filter((cell) => !isOmitted(row.row, cell.column)) }));
    const summaryFields = {
      steel_vermiculite: { SCHEDULE: [["A4", "A5"], ["G4", "G5"], ["S4", "S5"]] },
      steel_board: { "BOARD SUMMARY": [["A5", "A6"], ["E5", "E6"], ["I5", "I6"]] },
    };
    const pairs = summaryFields[entry.definition.id]?.[entry.sheet] || [];
    const mapped = new Map(rows.flatMap((row) => row.cells.map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell])));
    const used = new Set(pairs.flat()), cards = node("div", "calculator-summary-cards"), box = node("div", "calculator-overview");
    if (entry.definition.id === "ductwork" && entry.sheet === "CALCULATOR" || entry.definition.id === "steel_board" && ["CALCULATOR", "BOARD SUMMARY", "EXTRA BOARDS"].includes(entry.sheet)) box.classList.add("calculator-overview-full");
    const productSummary = entry.definition.id === "steel_vermiculite" && entry.sheet === "SCHEDULE";
    const boardSchedule = entry.definition.id === "steel_board" && entry.sheet === "CALCULATOR";
    if (productSummary) { used.add("M4"); used.add("M5"); }
    if (pairs.length === 3) cards.classList.add("calculator-summary-three");
    if (boardSchedule) for (const address of ["A4", "C4", "E4", "G4", "I4", "K4", "Y4", "AA4", "AC4", "AE4", "AG4", "AI4"]) used.add(address);
    for (const [labelAddress, valueAddress] of pairs) {
      const label = mapped.get(labelAddress), value = mapped.get(valueAddress);
      if (!label || !value || !columns.includes(value.column)) continue;
      const card = node("div", "calculator-summary-metric"), heading = node("span", "", sourceDisplayText(label.value, entry, labelAddress)), output = node("strong");
      applyCellDisplay(heading, metadata.display_cells[labelAddress]); applyCellDisplay(output, metadata.display_cells[valueAddress]);
      output.dataset.calculatorValue = "true"; output.calculatorValueCard = card;
      output.dataset.calculatorOutput = valueAddress; updateOutputCell(output, value); card.append(heading, output); cards.append(card);
    }
    let cardsPlaced = false;
    const appendSummary = () => {
      if (cardsPlaced) return;
      if (pairs.length) box.append(cards);
      cardsPlaced = true;
    };
    for (const row of rows) for (const cell of row.cells) {
      if (!columns.includes(cell.column) || cell.value == null || cell.value === "") continue;
      const address = cell.address || `${columnName(cell.column)}${row.row}`;
      if (used.has(address)) {
        appendSummary();
        continue;
      }
      const display = metadata.display_cells[address] || {}, role = display.role || presentationRole(cell);
      const item = node(isNumber(cell.value) ? "strong" : role === "title" ? "h3" : "p", `calculator-overview-${isNumber(cell.value) ? "metric" : role}`);
      applyCellDisplay(item, display);
      if (cell.calculated || isNumber(cell.value) || !["title", "section", "column_header", "label"].includes(role)) item.dataset.calculatorValue = "true";
      item.dataset.calculatorOutput = address;
      updateOutputCell(item, cell); box.append(item);
    }
    return box;
  }

  function renderProductTotals(result, container) {
    if (!container) return;
    const board = Array.isArray(result?.board_product_totals);
    const totals = (board ? result.board_product_totals : result?.product_totals) || [];
    container.hidden = !totals.length;
    if (!totals.length) { container.replaceChildren(); return; }
    const heading = node("h4", "", board ? "CALCULATED SUMMARY" : "PRODUCT SUMMARY"), note = node("p", "", board ? "Box reference area measures the enclosure used for the board takeoff. Net board area and whole sheets include valid additional boards. Review products with incomplete rows." : "Whole bags use each product’s combined order quantity, including its configured waste. A blank total remains withheld; review the order status.");
    const scroll = node("div", "calculator-product-totals-scroll"), table = node("table"), head = node("thead"), body = node("tbody"), headers = node("tr");
    for (const label of board ? ["Product", "Box reference area (m²)", "Net board area (m²)", "Whole sheets", "Order status"] : ["Product", "Net bags", "Whole bags", "Order status"]) { const cell = node("th", "", label); cell.scope = "col"; headers.append(cell); }
    head.append(headers);
    for (const total of totals) {
      const row = node("tr"), product = node("th", "", total.product); product.scope = "row"; row.append(product);
      const incomplete = board ? [[total.incomplete_rows, "schedule rows"], [total.incomplete_extra_rows, "additional-board rows"]].filter(([count]) => count > 0).map(([count, label]) => `${displayValue(count)} incomplete ${label}`) : [];
      const status = !board ? total.status : incomplete.length ? `${incomplete.join("; ")} — totals need review` : total.incomplete_rows == null && total.incomplete_extra_rows == null ? "" : "No incomplete rows";
      for (const value of board ? [total.box_reference_area, total.net_board_area, total.whole_sheets, status] : [total.net_bags, total.whole_bags, status]) { const cell = node("td", typeof value === "string" ? "calculator-product-order-status" : ""); cell.dataset.calculatorValue = "true"; updateOutputCell(cell, { value }); row.append(cell); }
      body.append(row);
    }
    table.append(head, body); scroll.append(table); container.replaceChildren(heading, note, scroll);
  }

  function sectionDetails(entry, result, metadata) {
    const cells = new Map(result.rows.flatMap((row) => row.cells.map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell])));
    const isOmitted = omittedCell(metadata), omittedRows = new Set(metadata.omitted_rows), omittedColumns = new Set(metadata.omitted_columns);
    return (metadata.section_cells || []).map((address, index) => {
      const position = parseAddress(address);
      if (!position || omittedRows.has(position.row) || omittedColumns.has(position.column) || isOmitted(position.row, position.column)) return null;
      const cell = cells.get(address);
      return cell && cell.value !== null && cell.value !== "" ? { address, label: sourceDisplayText(cell.value, entry, address, result), id: `calculator-section-${entry.definition.id}-${entry.sheet.replace(/\W+/g, "-")}-${address}`, theme: index % 11 } : null;
    }).filter(Boolean);
  }

  function renderContents(sections) {
    const contents = node("nav", "calculator-contents"), links = node("div", "calculator-contents-links");
    contents.setAttribute("aria-label", "Worksheet contents"); contents.append(node("p", "calculator-contents-title", "On this page"));
    for (const section of sections) { const link = node("a", `calculator-section-theme-${section.theme}`, section.label); link.href = `#${section.id}`; links.append(link); }
    contents.append(links); return contents;
  }

  function settingsPanels(entry, definitions) {
    const page = currentPage(entry), chooser = node("div", "calculator-settings-chooser"), panels = new Map(), buttons = new Map();
    chooser.setAttribute("role", "group"); chooser.setAttribute("aria-label", "Settings sections");
    entry.settingsSelection ||= {};
    const update = () => {
      for (const [id, panel] of panels) {
        const expanded = entry.settingsSelection[page] === id;
        panel.hidden = !expanded; buttons.get(id).setAttribute("aria-expanded", String(expanded));
      }
    };
    for (const [index, definition] of definitions.entries()) {
      const prefix = `calculator-settings-${entry.definition.id}-${page}-${definition.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
      const button = node("button", `calculator-settings-choice calculator-section-theme-${index % 11}`, definition.label), panel = node("section", "calculator-settings-panel");
      button.type = "button"; button.id = `${prefix}-button`; button.dataset.calculatorSettingsSection = definition.id; button.setAttribute("aria-controls", prefix);
      panel.id = prefix; panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", button.id);
      button.addEventListener("click", () => {
        if (current() !== entry || currentPage(entry) !== page) return;
        entry.settingsSelection[page] = entry.settingsSelection[page] === definition.id ? null : definition.id;
        if (entry.pendingResult && !entry.invalid.size) { entry.result = entry.pendingResult; entry.pendingResult = null; renderGrid(entry); }
        else update();
      });
      chooser.append(button); buttons.set(definition.id, button); panels.set(definition.id, panel);
    }
    update(); return { chooser, panels };
  }

  function renderGrid(entry = current()) {
    if (!entry?.result || entry !== current()) return;
    const grid = $("calculator-grid"), result = entry.result, metadata = displayMetadata(entry), page = pageDefinition(entry);
    const sectionSpacing = Boolean(result.section_spacing ?? metadata.section_spacing);
    grid.classList.toggle("calculator-grid-expanded", Boolean(metadata.expand_tables));
    entry.productTotalsElement = null;
    const scrollLeft = grid.scrollLeft, scrollTop = grid.scrollTop;
    const hidden = hiddenColumns(metadata);
    const omittedRows = new Set(metadata.omitted_rows), omittedColumns = new Set(metadata.omitted_columns), isOmitted = omittedCell(metadata);
    const visibleRows = result.rows.filter((row) => !omittedRows.has(row.row)).map((row) => ({ ...row, cells: row.cells.filter((cell) => !isOmitted(row.row, cell.column)) }));
    let columns = (result.visible_columns || Array.from({ length: result.max_column }, (_, index) => index + 1).filter((column) => !hidden.has(column))).filter((column) => !omittedColumns.has(column));
    columns = [...new Set([...metadata.display_column_order.map(columnNumber).filter((column) => columns.includes(column)), ...columns])];
    const labels = headerLabels(entry, result);
    const schedule = entry.definition.schedule?.sheet === entry.sheet ? entry.definition.schedule : entry.sheet === "EXTRA BOARDS" ? { first_row: 6, last_row: 45, header_row: 5 } : null;
    const syntheticLine = Boolean(schedule?.line_numbers), lineColumn = columnNumber(schedule?.line_id_column), lineWidth = 70;
    const exposureColumns = new Set((schedule?.columns || []).filter((column) => column.editable && /exposure/i.test(column.label)).map((column) => columnNumber(column.column)));
    const presentationTables = metadata.presentation_tables;
    const stackedTables = metadata.table_layout === "stacked" && presentationTables.length > 0;
    const projectedTables = metadata.table_layout === "projected" && presentationTables.length > 0;
    const sourceSettings = metadata.navigation_mode === "select" ? metadata.settings_sections.map((section) => ({ ...section, bounds: section.ranges.map((range) => { const [start, end] = range.split(":").map(parseAddress); return { start, end: end || start }; }) })) : [];
    const settingsDefinitions = sourceSettings.filter((section) => !Array.isArray(page.section_ids) || page.section_ids.includes(section.id));
    // Excluded sections still own their cells: they must never leak into a
    // virtual page's common introduction merely because its chooser omits them.
    const sectionOwner = (row, column) => sourceSettings.find((section) => section.bounds.some(({ start, end }) => row >= start.row && row <= end.row && column >= start.column && column <= end.column))?.id || null;
    const boardSummary = entry.definition.id === "steel_board" && entry.sheet === "BOARD SUMMARY";
    const tableForRow = (row) => presentationTables.findIndex((table) => row >= table.first_row && row <= table.last_row);
    const displayMerges = Object.values(metadata.display_cells).map((cell) => cell.merge).filter(Boolean);
    const sourceMerges = (metadata.merges || []).filter((range) => !displayMerges.some((override) => override.split(":")[0] === range.split(":")[0]));
    const merges = [...displayMerges, ...sourceMerges].map((range) => {
      const [start, end] = range.split(":").map(parseAddress); return start ? { start, end: end || start } : null;
    }).filter(Boolean);
    const regions = presentationTables.map((definition, index) => {
      const headingRanges = [definition.title_address, definition.subtitle_address].map(parseAddress).filter(Boolean)
        .map((position) => merges.find(({ start }) => start.row === position.row && start.column === position.column) || { start: position, end: position });
      const regionColumns = new Set(definition.columns.map(columnNumber));
      return { definition, index, contains: (row, column) => row >= definition.first_row && row <= definition.last_row && regionColumns.has(column),
        isTitle: (row, column) => headingRanges.some(({ start, end }) => row >= start.row && row <= end.row && column >= start.column && column <= end.column) };
    });
    if (!schedule) {
      const occupied = new Set(), populated = new Set();
      for (const row of visibleRows) for (const cell of row.cells) if (columns.includes(cell.column) && (cell.editable || (cell.value !== null && cell.value !== undefined && cell.value !== ""))) {
        occupied.add(cell.column); populated.add(`${cell.column}:${row.row}`);
      }
      for (const merge of merges) if (populated.has(`${merge.start.column}:${merge.start.row}`)) for (const column of columns) if (column >= merge.start.column && column <= merge.end.column) occupied.add(column);
      for (const table of presentationTables) for (const column of table.columns) occupied.add(columnNumber(column));
      columns = columns.filter((column) => occupied.has(column));
    }
    const rows = visibleRows.filter((row) => !(entry.definition.id === "steel_vermiculite" && entry.sheet === "SETTINGS" && row.row === 5) && !(boardSummary && row.row <= 10)).filter((row) => schedule ? row.row >= schedule.first_row && row.row <= schedule.last_row : tableForRow(row.row) >= 0 || row.cells.some((cell) => columns.includes(cell.column) && (cell.editable || (cell.value !== null && cell.value !== undefined && cell.value !== ""))));
    const sourceCells = new Map(visibleRows.flatMap((row) => row.cells.map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell])));
    const projectedTitles = new Set(presentationTables.flatMap((table) => [table.title_address, table.subtitle_address]).filter(Boolean));
    const tableLinks = stackedTables || projectedTables ? presentationTables.map((table, index) => {
      if (projectedTables && !table.title_address) return null;
      const titleCell = sourceCells.get(table.title_address);
      return { label: titleCell ? sourceDisplayText(titleCell.value, entry, table.title_address) : table.label, sourceRow: table.first_row,
        id: `calculator-table-section-${entry.definition.id}-${entry.sheet.replace(/\W+/g, "-")}-${index}`, theme: index % 11 };
    }) : [];
    const sectionLinks = [...sectionDetails(entry, { ...result, rows: visibleRows }, metadata).filter((section) => !projectedTitles.has(section.address)), ...tableLinks.filter(Boolean)]
      .sort((left, right) => (left.sourceRow ?? parseAddress(left.address)?.row ?? 0) - (right.sourceRow ?? parseAddress(right.address)?.row ?? 0));
    sectionLinks.forEach((section, index) => { section.theme = index % 11; });
    const sectionsByAddress = new Map(sectionLinks.filter((section) => section.address).map((section) => [section.address, section]));
    state.optionLists.clear(); state.optionKeys = new WeakMap(); $("calculator-option-lists").replaceChildren();
    // These two source forms contain independent comparison matrices. Keeping
    // them separate lets the form stack on a phone while the matrix stays aligned.
    const matrix = !projectedTables && entry.definition.id === "steel_vermiculite" ? ({ CALCULATOR: { first: 28, last: 30, label: "Published fire-period comparison" }, BAGS: { first: 19, last: 24, label: "Product order summary" } })[entry.sheet] : null;
    const periodMatrix = matrix && entry.sheet === "CALCULATOR";
    const head = node("thead"), sections = new Map(), widths = [];
    const groupForRow = (row) => {
      const index = tableForRow(row);
      if (index >= 0) return `table-${index}`;
      if (presentationTables.length) return `content-${presentationTables.filter((table) => table.last_row < row).length}`;
      return matrix ? row < matrix.first ? "before" : row <= matrix.last ? "matrix" : "after" : "all";
    };
    const addGroup = (group, sourceRows, definition, visibleCell = () => true) => {
      if (projectedTables && !definition) sourceRows = sourceRows.map((row) => ({ ...row, cells: row.cells.filter((cell) => visibleCell(row.row, cell.column)) }))
        .filter((row) => row.cells.some((cell) => cell.editable || cell.value !== null && cell.value !== undefined && cell.value !== ""));
      if (!sourceRows.length) return;
      let groupColumns = definition ? definition.columns.map(columnNumber).filter((column) => columns.includes(column)) : matrix && group === "matrix" ? columns.filter((column) => column <= 9) : columns;
      const region = definition && regions[presentationTables.indexOf(definition)];
      if (region?.definition.title_address) sourceRows = sourceRows.filter((row) => groupColumns.some((column) => !region.isTitle(row.row, column)));
      if (definition?.table_kind === "form") sourceRows = sourceRows.filter((row) => row.cells.some((cell) => groupColumns.includes(cell.column) && !region.isTitle(row.row, cell.column) && (cell.editable || cell.calculated || cell.value !== null && cell.value !== undefined && cell.value !== "")));
      if (definition?.header_row) sourceRows = sourceRows.filter((row) => row.row >= definition.header_row || row.cells.some((cell) => groupColumns.includes(cell.column) && !region.isTitle(row.row, cell.column) && (cell.editable || cell.calculated || cell.value !== null && cell.value !== undefined && cell.value !== "")));
      if ((stackedTables || projectedTables) && !definition) {
        const occupied = new Set(sourceRows.flatMap((row) => row.cells.filter((cell) => cell.editable || cell.value !== null && cell.value !== undefined && cell.value !== "").map((cell) => cell.column)));
        for (const merge of merges) if (sourceRows.some((row) => row.row === merge.start.row && row.cells.some((cell) => cell.column === merge.start.column && cell.value != null && cell.value !== ""))) for (const column of groupColumns) if (column >= merge.start.column && column <= merge.end.column) occupied.add(column);
        groupColumns = groupColumns.filter((column) => occupied.has(column));
      }
      sections.set(group, { body: node("tbody"), rows: sourceRows.map((row) => row.row), sourceRows, definition, columns: groupColumns, visibleCell, region });
    };
    if (projectedTables) {
      const clusters = [];
      for (const region of [...regions].sort((left, right) => left.definition.first_row - right.definition.first_row)) {
        let cluster = clusters.at(-1);
        if (!cluster || region.definition.first_row > cluster.last) { cluster = { first: region.definition.first_row, last: region.definition.last_row, regions: [] }; clusters.push(cluster); }
        cluster.last = Math.max(cluster.last, region.definition.last_row); cluster.regions.push(region);
      }
      let afterRow = 0;
      for (const [index, cluster] of clusters.entries()) {
        addGroup(`content-${index}`, rows.filter((row) => row.row >= afterRow && row.row < cluster.first));
        for (const region of cluster.regions.sort((left, right) => left.index - right.index)) addGroup(`table-${region.index}`, rows.filter((row) => row.row >= region.definition.first_row && row.row <= region.definition.last_row), region.definition);
        addGroup(`remainder-${index}`, rows.filter((row) => row.row >= cluster.first && row.row <= cluster.last), undefined, (row, column) => !cluster.regions.some((region) => region.contains(row, column)));
        afterRow = cluster.last + 1;
      }
      addGroup("after", rows.filter((row) => row.row >= afterRow));
    } else if (stackedTables) {
      const first = Math.min(...presentationTables.map((table) => table.first_row));
      addGroup("before", rows.filter((row) => row.row < first));
      presentationTables.forEach((definition, index) => addGroup(`table-${index}`, rows.filter((row) => row.row >= definition.first_row && row.row <= definition.last_row), definition));
      addGroup("after", rows.filter((row) => row.row >= first && tableForRow(row.row) < 0));
    } else {
      for (const row of rows) {
        const group = groupForRow(row.row), definition = presentationTables[tableForRow(row.row)];
        if (!sections.has(group)) addGroup(group, rows.filter((candidate) => groupForRow(candidate.row) === group), definition);
      }
    }
    if (sourceSettings.length) {
      const originalGroups = [...sections]; sections.clear();
      for (const owner of [...(page.include_common === false ? [] : [null]), ...settingsDefinitions.map((section) => section.id)]) for (const [key, original] of originalGroups) {
        const visibleCell = (row, column) => original.visibleCell(row, column) && sectionOwner(row, column) === owner;
        const sourceRows = original.sourceRows.map((row) => ({ ...row, cells: row.cells.filter((cell) => original.columns.includes(cell.column) && visibleCell(row.row, cell.column) && !(owner === null && page.hidden_common_addresses?.includes(cell.address || `${columnName(cell.column)}${row.row}`))) }))
          .filter((row) => row.cells.some((cell) => cell.editable || cell.calculated || cell.value !== null && cell.value !== undefined && cell.value !== "") || owner && original.definition && original.columns.some((column) => visibleCell(row.row, column)));
        if (!sourceRows.length) continue;
        let groupColumns = original.columns.filter((column) => sourceRows.some((row) => visibleCell(row.row, column)));
        if (!owner) {
          const occupied = new Set(sourceRows.flatMap((row) => row.cells.filter((cell) => cell.editable || cell.calculated || cell.value !== null && cell.value !== undefined && cell.value !== "").map((cell) => cell.column)));
          for (const merge of merges) if (sourceRows.some((row) => row.row === merge.start.row && row.cells.some((cell) => cell.column === merge.start.column && cell.value != null && cell.value !== ""))) for (const column of groupColumns) if (column >= merge.start.column && column <= merge.end.column) occupied.add(column);
          groupColumns = groupColumns.filter((column) => occupied.has(column));
        }
        sections.set(`${key}-settings-${owner || "common"}`, { ...original, body: node("tbody"), sourceRows, rows: sourceRows.map((row) => row.row), columns: groupColumns, visibleCell, settingsSectionId: owner });
      }
    }
    const sectionStarts = sectionLinks.filter((section) => section.address).map((section) => parseAddress(section.address).row).sort((left, right) => left - right);
    if (sectionSpacing) {
      const originalGroups = [...sections]; sections.clear();
      for (const [key, group] of originalGroups) {
        if (group.definition) { sections.set(key, group); continue; }
        const runs = [];
        for (const row of group.sourceRows) {
          if (!runs.length || sectionStarts.includes(row.row)) runs.push([]);
          runs.at(-1).push(row);
        }
        runs.forEach((sourceRows, index) => sections.set(`${key}-part-${index}`, { ...group, body: node("tbody"), sourceRows, rows: sourceRows.map((row) => row.row) }));
      }
    }
    const headRow = node("tr");
    if (syntheticLine) { const heading = node("th", "calculator-line-number", "Line"); heading.scope = "col"; headRow.append(heading); }
    for (const column of columns) {
      const label = String(labels[column] || "");
      const minimum = !schedule ? 24 : /notes?|status|requirements|basis|sources?/i.test(label) ? 360 : /product|steel id|section|member mark|item.*mark|location|duct use/i.test(label) ? 220 : 125;
      const width = schedule && column === lineColumn ? lineWidth : Math.max(minimum, Math.min(schedule ? 420 : 320, (Number(metadata.column_widths?.[column]) || 22) * 7));
      widths.push(width);
      const heading = node("th", "", labels[column] || ""); heading.scope = "col"; headRow.append(heading);
    }
    head.append(headRow);
    let introPlaced = false;
    for (const [group, renderedGroup] of sections) for (const row of renderedGroup.sourceRows) {
      const groupColumns = renderedGroup.columns;
      const tr = node("tr"), values = new Map(row.cells.map((cell) => [cell.column, cell]));
      const item = schedule ? row.row - schedule.first_row + 1 : "";
      tr.dataset.sourceRow = String(row.row);
      if (syntheticLine) tr.append(node("td", "calculator-line-number", item));
      const requestedLayout = renderedGroup.definition?.row_layouts?.[row.row];
      let rowLayout = null;
      if (Array.isArray(requestedLayout) && requestedLayout.length) {
        const proposed = requestedLayout.map((placement) => ({ ...parseAddress(placement?.address), span: placement?.span })), layoutColumns = new Set(proposed.map((placement) => placement.column));
        const visibleColumn = (column) => groupColumns.includes(column) && !isOmitted(row.row, column) && renderedGroup.visibleCell(row.row, column) && !renderedGroup.region?.isTitle(row.row, column);
        const requiredColumns = row.cells.filter((cell) => visibleColumn(cell.column) && (cell.editable || cell.calculated || cell.value !== null && cell.value !== undefined && cell.value !== "")).map((cell) => cell.column);
        if (layoutColumns.size === proposed.length && proposed.every((placement) => placement.row === row.row && visibleColumn(placement.column) && values.has(placement.column) && Number.isInteger(placement.span) && placement.span > 0) && proposed.reduce((total, placement) => total + placement.span, 0) === groupColumns.length && requiredColumns.every((column) => layoutColumns.has(column))) rowLayout = proposed;
      }
      for (const placement of rowLayout || groupColumns.map((column) => ({ column }))) {
        const column = placement.column;
        if (isOmitted(row.row, column) || !renderedGroup.visibleCell(row.row, column) || renderedGroup.region?.isTitle(row.row, column)) continue;
        const merge = merges.find(({ start, end }) => column >= start.column && column <= end.column && row.row >= start.row && row.row <= end.row);
        if (!rowLayout && merge && (column !== groupColumns.find((visible) => visible >= merge.start.column && visible <= merge.end.column) || row.row !== renderedGroup.rows.find((visible) => visible >= merge.start.row && visible <= merge.end.row))) continue;
        const cell = values.get(column) || { column, value: null };
        const definition = renderedGroup.definition;
        const headerRow = definition && (Object.prototype.hasOwnProperty.call(definition, "header_row") ? definition.header_row : definition.title_address || definition.table_kind === "form" ? null : definition.first_row);
        const hasOwnHeader = Boolean(definition && Object.prototype.hasOwnProperty.call(definition, "header_row"));
        const sourceHeading = (!hasOwnHeader || headerRow === row.row) && (metadata.header_rows || []).includes(row.row);
        const matrixHeading = group === "matrix" && row.row === matrix.first || Boolean(definition) && headerRow === row.row;
        const section = sectionsByAddress.get(cell.address || `${columnName(column)}${row.row}`);
        const display = metadata.display_cells[cell.address || `${columnName(column)}${row.row}`] || {};
        let role = display.role || (["SETTINGS", "PRODUCT SETTINGS"].includes(entry.sheet) && column === 1 && row.row === 1 ? "title" : presentationRole(cell));
        if (hasOwnHeader && row.row !== headerRow && role === "column_header" && !section) role = "body";
        if (definition?.table_kind === "form" && role === "section" && !section && !(merge && groupColumns.every((visible) => visible >= merge.start.column && visible <= merge.end.column))) role = "label";
        const explicitHeading = matrixHeading || sourceHeading || Boolean(section) || role === "title";
        if (!explicitHeading && (cell.calculated || cell.output || cell.read_only)) role = "output";
        const td = node(matrixHeading ? "th" : "td", `calculator-role-${role}`);
        if (schedule && column === lineColumn) td.classList.add("calculator-line-number");
        if (matrixHeading) td.scope = "col";
        if (section) { td.id = section.id; td.classList.add("calculator-section-anchor", `calculator-section-theme-${section.theme}`); }
        applyCellDisplay(td, display, cell.presentation?.bold);
        if (schedule && !explicitHeading && exposureColumns.has(column)) td.classList.add("calculator-exposure-input");
        if (rowLayout) {
          td.colSpan = placement.span; td.rowSpan = merge ? renderedGroup.rows.filter((visible) => visible >= row.row && visible <= merge.end.row).length || 1 : 1;
          if (placement.span > 1) td.classList.add("calculator-merged");
        } else if (merge) {
          td.colSpan = groupColumns.filter((visible) => visible >= merge.start.column && visible <= merge.end.column).length;
          td.rowSpan = renderedGroup.rows.filter((visible) => visible >= row.row && visible <= merge.end.row).length || 1;
          td.classList.add("calculator-merged");
        }
        if (cell.editable) {
          td.classList.add("calculator-editable");
          const preceding = row.cells.filter((candidate) => candidate.column < column && typeof candidate.value === "string" && candidate.value.trim()).at(-1)?.value;
          const label = cell.label || labels[column] || preceding || "Calculator input";
          td.append(makeControl(cell, row.row, entry, `${label}${item ? `, item ${item}` : ""}`));
        } else {
          const structural = matrixHeading || sourceHeading || ["title", "section", "column_header"].includes(role);
          const tableValue = Boolean(schedule) || group === "matrix" || Boolean(renderedGroup.definition) || referenceTableValue(entry, row.row, column);
          if (!structural && (tableValue || cell.output || cell.calculated || role === "output" || role !== "label" && cell.value !== null && cell.value !== undefined && cell.value !== "")) td.dataset.calculatorValue = "true";
          td.dataset.calculatorOutput = cell.address || `${columnName(column)}${row.row}`;
          updateOutputCell(td, cell);
          if (sourceHeading) td.classList.add("calculator-source-heading");
        }
        tr.append(td);
      }
      renderedGroup.body.append(tr);
      if (!introPlaced && page.intro_address && row.cells.some((cell) => cell.address === page.intro_after_address)) {
        const intro = sourceCells.get(page.intro_address);
        if (intro) {
          const introRow = node("tr"), introCell = node("td", "calculator-role-note calculator-normal");
          introRow.dataset.sourceRow = String(parseAddress(page.intro_address).row);
          introCell.colSpan = groupColumns.length; introCell.dataset.calculatorOutput = page.intro_address;
          introCell.dataset.calculatorValue = "true"; updateOutputCell(introCell, intro);
          introRow.append(introCell); renderedGroup.body.append(introRow); introPlaced = true;
        }
      }
    }
    const content = [];
    const settings = settingsDefinitions.length && page.section_mode !== "content" ? settingsPanels(entry, settingsDefinitions) : null;
    if (sectionLinks.length && metadata.navigation_mode === "links") content.push(renderContents(sectionLinks));
    const boardSchedule = Boolean(schedule && entry.definition.id === "steel_board" && entry.sheet === "CALCULATOR");
    const scheduleOverview = schedule ? renderOverview(visibleRows.filter((row) => row.row < schedule.header_row), entry, columns) : null;
    if (scheduleOverview && !boardSchedule) content.push(scheduleOverview);
    if (boardSummary) content.push(renderOverview(visibleRows.filter((row) => row.row <= 10), entry, columns));
    if (schedule && (entry.definition.id === "steel_vermiculite" && entry.sheet === "SCHEDULE" || entry.definition.id === "steel_board" && entry.sheet === "CALCULATOR")) {
      const totals = node("section", "calculator-product-totals"); totals.id = "calculator-product-totals";
      entry.productTotalsElement = totals; renderProductTotals(result, totals); content.push(totals);
    }
    if (boardSchedule) content.push(scheduleOverview);
    const logicalSections = new Map();
    const displayGroups = [...sections], tableSlots = displayGroups.map(([, group], index) => group.definition ? index : -1).filter((index) => index >= 0);
    if (metadata.display_table_order.length) {
      const priority = (group) => { const index = presentationTables.indexOf(group.definition), selected = metadata.display_table_order.indexOf(index); return selected < 0 ? metadata.display_table_order.length + index : selected; };
      const orderedTables = tableSlots.map((index) => displayGroups[index]).sort((left, right) => priority(left[1]) - priority(right[1]));
      tableSlots.forEach((index, position) => { displayGroups[index] = orderedTables[position]; });
    }
    for (const [group, renderedGroup] of displayGroups) {
      const { body, definition, columns: groupColumns } = renderedGroup;
      const responsive = definition?.table_kind === "form" || matrix && group !== "matrix";
      const table = node("table", schedule ? "calculator-schedule-table" : `calculator-form-table${responsive ? " calculator-responsive-form" : group === "matrix" || definition?.table_kind === "comparison" ? " calculator-comparison-table" : ""}`);
      const colgroup = node("colgroup");
      const legacyOrder = matrix && !periodMatrix && group === "matrix";
      const orderTable = legacyOrder || definition?.table_kind === "order";
      const fitBagsForm = matrix && !periodMatrix && group !== "matrix";
      const fitContent = presentationTables.length > 0 && !definition;
      const fitWidth = fitBagsForm || fitContent || definition?.width_mode === "fit";
      if (orderTable) table.classList.add("calculator-order-table");
      if (fitBagsForm) table.classList.add("calculator-bags-form");
      if (fitContent) table.classList.add("calculator-content-table");
      if (definition) table.classList.add("calculator-projection-table");
      const groupWidths = definition ? groupColumns.map((column) => definition.column_widths?.[definition.columns.map(columnNumber).indexOf(column)] || 125) : matrix && group === "matrix" ? groupColumns.map((column) => orderTable ? [19, 7, 9, 10, 8, 7, 11, 9, 20][column - 1] : column === 1 ? 100 : 88) : groupColumns.map((column) => widths[columns.indexOf(column)]);
      if (syntheticLine) groupWidths.unshift(lineWidth);
      const totalWidth = groupWidths.reduce((sum, width) => sum + width, 0);
      for (const width of groupWidths) { const col = node("col"); col.style.width = `${fitWidth ? width / totalWidth * 100 : width}${legacyOrder || fitWidth ? "%" : "px"}`; colgroup.append(col); }
      table.style.width = legacyOrder || fitWidth ? "100%" : `${totalWidth}px`; table.append(colgroup);
      if (schedule) table.append(head);
      table.append(body);
      const scroll = node("div", `calculator-table-scroll${responsive ? " calculator-responsive-scroll" : ""}`);
      if (definition || metadata.expand_tables || !schedule && ["SETTINGS", "PRODUCT SETTINGS"].includes(entry.sheet)) scroll.classList.add("calculator-section-scroll");
      const tableLabel = definition?.label || (group === "matrix" ? matrix.label : null);
      if (tableLabel) { table.setAttribute("aria-label", tableLabel); scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", `${tableLabel} · scroll horizontally for all columns`); scroll.tabIndex = 0; }
      scroll.append(table);
      const link = definition && tableLinks[presentationTables.indexOf(definition)];
      const append = (element) => {
        const panel = settings?.panels.get(renderedGroup.settingsSectionId);
        if (panel) panel.append(element);
        else if (sectionSpacing) {
          const first = renderedGroup.sourceRows[0]?.row ?? 0, start = sectionStarts.filter((row) => row <= first).at(-1) ?? 0;
          if (!logicalSections.has(start)) { const section = node("section", "calculator-logical-section"); logicalSections.set(start, section); content.push(section); }
          logicalSections.get(start).append(element);
        } else content.push(element);
      };
      if (link) {
        const section = node("section", projectedTables ? "calculator-projected-section" : "calculator-stacked-section"), heading = node("h4", `calculator-section-anchor calculator-section-theme-${link.theme}`, link.label); heading.id = link.id;
        const titleCell = sourceCells.get(definition.title_address);
        applyCellDisplay(heading, metadata.display_cells[definition.title_address]);
        if (titleCell) { heading.dataset.calculatorOutput = definition.title_address; updateOutputCell(heading, titleCell); }
        section.append(heading);
        const subtitleCell = sourceCells.get(definition.subtitle_address);
        if (subtitleCell) {
          const subtitle = node("p", "calculator-projected-note");
          subtitle.dataset.calculatorOutput = definition.subtitle_address;
          applyCellDisplay(subtitle, metadata.display_cells[definition.subtitle_address]); updateOutputCell(subtitle, subtitleCell);
          section.append(subtitle);
        }
        section.append(scroll); append(section);
      }
      else if (schedule && metadata.schedule_heading) {
        const section = node("section", "calculator-schedule-section"), heading = node("h4", "", metadata.schedule_heading);
        section.append(heading, scroll); append(section);
      } else append(scroll);
    }
    if (settings) content.push(settings.chooser, ...settings.panels.values());
    grid.replaceChildren(...content); grid.scrollLeft = scrollLeft; grid.scrollTop = scrollTop;
    entry.renderedSheet = entry.sheet; entry.renderedPage = currentPage(entry); entry.choiceSignature = choiceSignature(result); entry.needsRender = false;
    $("calculator-page-status").textContent = schedule ? `${rows.length.toLocaleString("en-AU")} schedule rows · Scroll to any item` : `${rows.length.toLocaleString("en-AU")} content rows · Complete worksheet`;
  }

  async function calculate() {
    const entry = current(); if (!entry || entry.invalid.size) return;
    clearTimeout(state.timer);
    const revision = entry.revision, sheet = entry.sheet, page = currentPage(entry), serial = ++state.requestRevision;
    calculationStatus("Calculating…");
    $("calculator-grid").setAttribute("aria-busy", "true");
    try {
      const result = await request(endpoint(entry.definition.id, "worksheet"), { method: "POST", body: JSON.stringify({ inputs: clone(entry.inputs), sheet, include_advanced: false }) });
      if (current() !== entry || serial !== state.requestRevision || revision !== entry.revision || sheet !== entry.sheet || page !== currentPage(entry)) return;
      if (result.inputs) entry.inputs = clone(result.inputs);
      entry.latestCells = new Map(result.rows.flatMap((row) => row.cells.map((cell) => [`${sheet}!${cell.address || `${columnName(cell.column)}${row.row}`}`, cell])));
      const active = document.activeElement;
      const canRefresh = !entry.needsRender && entry.renderedSheet === sheet && entry.renderedPage === page && entry.choiceSignature === choiceSignature(result);
      entry.result = result;
      if (canRefresh) { entry.pendingResult = null; refreshOutputs(result); }
      else if (!entry.needsRender && (active?.dataset?.calculatorCell || active?.dataset?.calculatorCustomCell) && active.dataset.calculatorSheet === sheet) { entry.pendingResult = result; refreshOutputs(result); }
      else { entry.pendingResult = null; renderGrid(entry); }
      const copiedFixingNote = "The copied fixing instructions use the first schedule row’s fixed technical references on every row. This is the approved correction to the source workbook; quantity formulas are unchanged.";
      const hideCopiedFixingNote = entry.definition.id === "ductwork" && ["CALCULATOR", "SUMMARY", "PRODUCT SETTINGS"].includes(sheet);
      const warnings = (result.warnings || []).map((warning) => typeof warning === "string" ? warning : warning.message || warning.label || "").filter((warning) => warning && !(hideCopiedFixingNote && warning === copiedFixingNote));
      $("calculator-warnings").textContent = warnings.join("\n"); $("calculator-warnings").hidden = !warnings.length;
      calculationStatus();
      updateStatus(entry);
    } catch (error) {
      if (current() === entry && serial === state.requestRevision && revision === entry.revision && page === currentPage(entry)) { message(`Could not calculate. ${error.message}`, true); calculationStatus("Calculation needs attention"); }
    } finally { if (serial === state.requestRevision) $("calculator-grid").setAttribute("aria-busy", "false"); }
  }

  async function selectPage(id) {
    const entry = current(), page = entry && displayPages(entry.definition).find((item) => item.id === id); if (!page) return;
    if (entry.invalid.size) { message("Correct the invalid number before changing pages.", true); return; }
    entry.page = page.id; entry.sheet = page.sheet; entry.pendingResult = null; entry.result = null; entry.needsRender = true;
    $("calculator-sheet-title").textContent = page.label;
    $("calculator-grid").replaceChildren(node("p", "calculator-empty", "Loading this worksheet…"));
    renderPages(entry); message(); await calculate();
  }

  function renderPages(entry) {
    const buttons = displayPages(entry.definition).map((page) => {
      const button = node("button", "calculator-page", page.label); button.type = "button";
      button.setAttribute("aria-pressed", String(page.id === currentPage(entry))); button.addEventListener("click", () => selectPage(page.id)); return button;
    });
    $("calculator-pages").replaceChildren(...buttons);
  }

  function safeDocumentUrl(value) {
    try { const url = new URL(value, window.location.origin); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }

  function renderDocuments(entry) {
    const groups = new Map();
    for (const document of entry.definition.documents || []) {
      const url = safeDocumentUrl(document.url); if (!url) continue;
      const product = Array.isArray(document.products) && document.products.length ? document.products.join(" / ") : "Source information";
      if (!groups.has(product)) groups.set(product, []);
      const card = node("article", "calculator-document-card");
      if (/request/i.test(`${document.kind || ""} ${document.availability || ""}`)) card.classList.add("calculator-document-request");
      const metadata = [document.kind, document.availability].filter(Boolean).join(" · ");
      if (metadata) card.append(node("p", "calculator-document-meta", metadata));
      const link = node("a", "calculator-document-link", document.title || "Technical document");
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link);
      if (document.reference_coverage) card.append(node("p", "calculator-document-coverage", document.reference_coverage));
      if (document.notes && document.notes !== document.reference_coverage) card.append(node("p", "calculator-document-notes", document.notes));
      groups.get(product).push(card);
    }
    const sections = [];
    for (const [product, cards] of groups) {
      const section = node("section", "calculator-document-group"), grid = node("div", "calculator-document-cards");
      section.append(node("h4", "", product)); grid.append(...cards); section.append(grid); sections.push(section);
    }
    $("calculator-document-list").replaceChildren(...sections); $("calculator-documents").hidden = !sections.length;
  }

  function renderChoices() {
    $("calculator-list").replaceChildren(...(state.list || []).map((definition) => {
      const button = node("button", "calculator-choice"); button.type = "button";
      button.setAttribute("aria-pressed", String(definition.id === state.current));
      button.append(node("strong", "", definition.title), node("span", "", descriptions[definition.id] || "Workbook schedule and settings"));
      button.addEventListener("click", () => selectCalculator(definition.id)); return button;
    }));
  }

  async function selectCalculator(id) {
    const serial = ++state.loadRevision;
    try {
      let entry = state.entries.get(id);
      if (!entry) {
        const definition = await request(endpoint(id));
        if (serial !== state.loadRevision) return;
        const inputs = clone(definition.inputs || {});
        const page = displayPages(definition)[0];
        entry = state.entries.get(id) || { definition, inputs, saved: JSON.stringify(inputs), revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() };
        state.entries.set(id, entry);
      }
      if (serial !== state.loadRevision) return;
      state.current = id; ++state.requestRevision; clearTimeout(state.timer);
      $("calculator-workspace").hidden = false; $("calculator-title").textContent = entry.definition.title;
      $("calculator-sheet-title").textContent = pageDefinition(entry).label;
      renderChoices(); renderPages(entry); renderDocuments(entry); updateStatus(entry); message();
      if (entry.result) renderGrid(entry); else $("calculator-grid").replaceChildren(node("p", "calculator-empty", "Loading this worksheet…"));
      await calculate();
    } catch (error) { if (serial === state.loadRevision) message(`Could not open the calculator. ${error.message}`, true); }
  }

  async function open() {
    try {
      if (!state.list) { const data = await request("/api/calculators"); state.list = data.calculators; renderChoices(); }
      if (!state.current && state.list.length) await selectCalculator(state.list[0].id);
    } catch (error) { message(`Could not load the calculators. ${error.message}`, true); }
  }

  function confirmReplace(title, detail, buttonText) {
    const dialog = $("calculator-confirm-dialog");
    $("calculator-confirm-title").textContent = title; $("calculator-confirm-detail").textContent = detail; $("calculator-confirm-button").textContent = buttonText;
    return new Promise((resolve) => { dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); dialog.showModal(); });
  }

  async function save() {
    const entry = current(); if (!entry || entry.invalid.size || state.action) return;
    state.action = true; updateStatus();
    const snapshot = clone(entry.inputs), revision = entry.revision;
    try {
      const response = await request(endpoint(entry.definition.id, "state"), { method: "PUT", body: JSON.stringify({ inputs: snapshot }) });
      const saved = clone(response.inputs || snapshot); entry.saved = JSON.stringify(saved);
      if (entry.revision === revision) entry.inputs = saved;
      message(entry.revision === revision ? `${entry.definition.title} saved.` : "Calculator saved. Your later edits are still unsaved.");
    } catch (error) { message(`Could not save the calculator. ${error.message}`, true); }
    finally { state.action = false; updateStatus(); }
  }

  async function reset() {
    const entry = current(); if (!entry || state.action) return;
    state.action = true; updateStatus(); const revision = entry.revision;
    try {
      const defaultsDetail = entry.definition.defaults?.SETTINGS ? "reviewed product yields and supplied workbook example rows" : "supplied workbook defaults, including its example rows";
      if (!await confirmReplace("Reset calculator defaults?", `This replaces this calculator's draft schedule and settings with the ${defaultsDetail}. Click Save Project to keep the reset.`, "Reset draft")) return;
      if (current() !== entry || entry.revision !== revision) { message("The calculator changed while the confirmation was open. Review the latest draft and try again.", true); return; }
      entry.inputs = clone(entry.definition.defaults || {}); entry.invalid.clear(); entry.revision++; entry.pendingResult = null; entry.needsRender = true;
      message("Calculator defaults restored in this draft. Save Project to keep them."); await calculate();
    } finally { state.action = false; updateStatus(); }
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1]); reader.onerror = () => reject(new Error("The selected file could not be read.")); reader.readAsDataURL(file);
    });
  }

  async function importSchedule() {
    const input = $("calculator-import-file"), file = input.files?.[0]; input.value = "";
    const entry = current(); if (!file || !entry || state.action) return;
    if (file.size > 5 * 1024 * 1024) { message("Choose an Excel workbook smaller than 5 MB.", true); return; }
    if (!file.name.toLowerCase().endsWith(".xlsx")) { message("Choose an .xlsx schedule workbook.", true); return; }
    state.action = true; updateStatus(); const revision = entry.revision, snapshot = clone(entry.inputs);
    try {
      const content = await readFile(file);
      const result = await request(endpoint(entry.definition.id, "import"), { method: "POST", body: JSON.stringify({ filename: file.name, content_base64: content, inputs: snapshot }) });
      if (current() !== entry || entry.revision !== revision) { message("The calculator changed while the file was importing. Your edits were kept; import the file again to review it.", true); return; }
      if (!await confirmReplace("Replace the schedule draft?", `${result.imported_rows} schedule rows are ready to import. The imported schedule replaces the current schedule in this draft. Review the results, then click Save Project.`, "Apply to draft")) return;
      if (current() !== entry || entry.revision !== revision) { message("The calculator changed while the confirmation was open. Your edits were kept; import the file again.", true); return; }
      entry.inputs = clone(result.inputs); entry.invalid.clear(); entry.revision++; entry.pendingResult = null; entry.needsRender = true;
      message(`Imported ${result.imported_rows} schedule rows into the draft. Save Project to keep them.`); await calculate();
    } catch (error) { message(`Could not import the schedule. ${error.message}`, true); }
    finally { state.action = false; updateStatus(); }
  }

  async function exportTemplate() {
    const entry = current(); if (!entry || state.action) return;
    state.action = true; updateStatus();
    try {
      const response = await fetch(endpoint(entry.definition.id, "template"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Template export failed."); }
      const blob = await response.blob();
      if (!String(response.headers.get("Content-Type") || "").includes("spreadsheetml.sheet")) throw new Error("The server did not return an Excel workbook.");
      const url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = `ceasefire-${entry.definition.id}-schedule.xlsx`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      message("Schedule template exported. Complete its input columns, then use Import XLSX Schedule.");
    } catch (error) { message(`Could not export the template. ${error.message}`, true); }
    finally { state.action = false; updateStatus(); }
  }

  async function downloadCalculatedFile({ action, buttonId, filename, fixedFilename = false, label, mimeType, fileDescription }) {
    const entry = current(); if (!entry || entry.invalid.size || state.action) return;
    // Input events retain exact edits; blur completes dropdown validation before
    // the server calculates the captured draft for the downloaded file.
    const focused = document.activeElement;
    if ((focused?.dataset?.calculatorCell || focused?.dataset?.calculatorCustomCell) && focused.dataset.calculatorSheet === entry.sheet) focused.blur();
    if (current() !== entry || entry.invalid.size) return;
    const id = entry.definition.id, snapshot = clone(entry.inputs), revision = entry.revision;
    const projectDetails = mimeType === "application/pdf" ? clone(window.CeasefireProject?.details() || {}) : null;
    const button = $(buttonId), previousLabel = button.textContent;
    state.action = true; updateStatus();
    button.textContent = `Preparing ${label}…`; button.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(endpoint(id, action), { method: "POST", headers: { "Content-Type": "application/json", Accept: mimeType }, body: JSON.stringify({ inputs: snapshot, ...(projectDetails ? { project_details: projectDetails } : {}) }) });
      const contentType = String(response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok) {
        let detail = `The server could not create the ${label} (${response.status}).`;
        if (contentType === "application/json") { const error = await response.json().catch(() => null); if (typeof error?.error === "string") detail = error.error; }
        throw new Error(detail);
      }
      if (contentType !== mimeType) throw new Error(`The server did not return ${fileDescription}.`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("The server returned an empty file.");
      const url = URL.createObjectURL(blob), link = node("a");
      link.href = url; link.download = fixedFilename ? filename : `ceasefire-${id}-${filename}`; document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      const changed = current() !== entry || entry.revision !== revision || projectDetails && JSON.stringify(projectDetails) !== JSON.stringify(window.CeasefireProject?.details() || {});
      message(`${label} download started using the ${entry.definition.title} draft captured when you clicked Download.${changed ? " Your current draft was kept; later edits are not included." : ""}`);
    } catch (error) { message(`Could not download the ${label}. ${error.message}`, true); }
    finally { button.textContent = previousLabel; button.removeAttribute("aria-busy"); state.action = false; updateStatus(); }
  }

  function downloadSchedulePdf() {
    return downloadCalculatedFile({ action: "report.pdf", buttonId: "calculator-pdf", filename: "APPENDIX A.pdf", fixedFilename: true, label: "PDF Schedule", mimeType: "application/pdf", fileDescription: "a PDF report" });
  }

  function downloadExcelRegister() {
    return downloadCalculatedFile({ action: "register.xlsx", buttonId: "calculator-excel", filename: "APPENDIX A.xlsx", fixedFilename: true, label: "XLSX Schedule", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileDescription: "an Excel workbook" });
  }

  function downloadMaterialsSummaryPdf() {
    return downloadCalculatedFile({ action: "summary.pdf", buttonId: "calculator-summary-pdf", filename: "materials-summary.pdf", label: "PDF Summary", mimeType: "application/pdf", fileDescription: "a PDF report" });
  }

  $("calculator-reset").addEventListener("click", reset);
  $("calculator-recalculate").addEventListener("click", calculate);
  $("calculator-template").addEventListener("click", exportTemplate);
  $("calculator-import").addEventListener("click", () => $("calculator-import-file").click());
  $("calculator-import-file").addEventListener("change", importSchedule);
  $("calculator-pdf").addEventListener("click", downloadSchedulePdf);
  $("calculator-excel").addEventListener("click", downloadExcelRegister);
  $("calculator-summary-pdf").addEventListener("click", downloadMaterialsSummaryPdf);
  window.addEventListener("beforeunload", (event) => { if ([...state.entries.values()].some((entry) => dirty(entry) || entry.invalid.size)) { event.preventDefault(); event.returnValue = ""; } });
  function projectSnapshot() {
    document.activeElement?.blur?.();
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    if ([...state.entries.values()].some((entry) => entry.invalid.size)) throw new Error("Correct the invalid calculator inputs before saving a project.");
    return Object.fromEntries([...state.entries].map(([id, entry]) => [id, { inputs: clone(entry.inputs) }]));
  }

  function projectFingerprint() {
    return JSON.stringify({ action: state.action, entries: [...state.entries].map(([id, entry]) => [id, entry.inputs, entry.saved, [...entry.invalid]]) });
  }

  async function prepareProject(calculators) {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    const list = state.list || (await request("/api/calculators")).calculators;
    const entries = await Promise.all(list.map(async ({ id }) => {
      const definition = state.entries.get(id)?.definition || await request(endpoint(id));
      if (!calculators[id]?.inputs) throw new Error("The project is missing a calculator.");
      const page = displayPages(definition)[0];
      return [id, { definition, inputs: clone(calculators[id].inputs), saved: null, revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() }];
    }));
    return { list, entries };
  }

  function applyProject(prepared) {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    ++state.loadRevision; ++state.requestRevision; clearTimeout(state.timer);
    state.entries = new Map(prepared.entries); state.list = prepared.list; state.current = null;
    state.optionLists.clear(); state.optionKeys = new WeakMap(); state.nextListId = 0;
    $("calculator-option-lists").replaceChildren(); $("calculator-grid").replaceChildren();
    $("calculator-workspace").hidden = true; renderChoices(); message();
  }

  async function prepareDefaults() {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    const list = state.list || (await request("/api/calculators")).calculators;
    const definitions = await Promise.all(list.map(async ({ id }) => state.entries.get(id)?.definition || await request(endpoint(id))));
    const calculators = Object.fromEntries(definitions.map(definition => [definition.id, { inputs: clone(definition.defaults || {}) }]));
    const prepared = await prepareProject(calculators);
    for (const [, entry] of prepared.entries) entry.saved = JSON.stringify(entry.inputs);
    return prepared;
  }

  function markProjectSaved(calculators) {
    for (const [id, entry] of state.entries) {
      if (calculators[id]?.inputs) entry.saved = JSON.stringify(calculators[id].inputs);
    }
    updateStatus();
  }
  function hasUnsavedChanges() { return [...state.entries.values()].some(entry => dirty(entry) || entry.invalid.size); }

  async function completeProjectSnapshot() {
    const list = state.list || (await request("/api/calculators")).calculators;
    const context = state.entries;
    const definitions = await Promise.all(list.filter(({ id }) => !context.has(id)).map(async ({ id }) => request(endpoint(id))));
    if (state.entries !== context) throw new Error("The project changed while reading calculator inputs. Save it again when ready.");
    state.list = list;
    for (const definition of definitions) {
      if (context.has(definition.id)) continue;
      const inputs = clone(definition.inputs || {}), page = displayPages(definition)[0];
      context.set(definition.id, { definition, inputs, saved: JSON.stringify(inputs), revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() });
    }
    return projectSnapshot();
  }

  window.CeasefireCalculators = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject };
  Object.assign(window.CeasefireCalculators, { prepareDefaults, markProjectSaved, hasUnsavedChanges, completeProjectSnapshot });
})();
