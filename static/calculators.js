"use strict";

// Column choices belong to this browser, never to a project or calculation.
// Both workbook registers and the Firestopping schedule use this same control.
window.CeasefireScheduleColumns = (() => {
  const prefix = "ceasefire.scheduleColumns.v1.", preferences = new Map(), controls = new Set();
  let nextId = 0, opened = null;
  const text = (element, source) => window.CeasefireI18n?.text(element, source) || (element.textContent = source, element);
  function read(key) {
    if (!preferences.has(key)) {
      let hidden = [];
      try {
        const stored = JSON.parse(window.localStorage.getItem(prefix + key));
        if (stored?.version === 1 && Array.isArray(stored.hidden) && stored.hidden.length <= 128
          && stored.hidden.every(id => typeof id === "string" && /^[a-zA-Z0-9:_-]{1,64}$/.test(id))) hidden = stored.hidden;
      } catch (_) { /* Unavailable or invalid preferences leave every column visible. */ }
      preferences.set(key, new Set(hidden));
    }
    return preferences.get(key);
  }
  function save(key, hidden) {
    preferences.set(key, hidden);
    try { window.localStorage.setItem(prefix + key, JSON.stringify({ version: 1, hidden: [...hidden] })); } catch (_) {}
    for (const control of controls) if (control.key === key) { control.refresh(); control.changed?.(hidden); }
  }
  function create() {
    const host = document.createElement("div"), button = document.createElement("button"), panel = document.createElement("div");
    host.className = "schedule-column-chooser"; button.className = "calculator-page schedule-column-toggle"; button.type = "button";
    panel.className = "schedule-column-panel"; panel.id = `schedule-column-panel-${++nextId}`; panel.hidden = true; panel.setAttribute("role", "group");
    text(button, "Columns"); window.CeasefireI18n?.attr(panel, "aria-label", "Visible columns");
    button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", panel.id); host.append(button, panel);
    const control = { host, button, panel, key: null, columns: [], changed: null, inputs: [],
      close(focus = false) { panel.hidden = true; button.setAttribute("aria-expanded", "false"); if (opened === control) opened = null; if (focus) button.focus({ preventScroll: true }); },
      position() {
        const rect = button.getBoundingClientRect(), width = Math.min(340, window.innerWidth - 24);
        const rtl = document.documentElement.dir === "rtl", left = Math.max(12, Math.min(rtl ? rect.left : rect.right - width, window.innerWidth - width - 12));
        panel.style.width = `${width}px`; panel.style.left = `${left}px`;
        panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 160))}px`;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - parseFloat(panel.style.top) - 12)}px`;
      },
      refresh() {
        const hidden = read(control.key), shown = control.columns.filter(column => !hidden.has(column.id)).length;
        control.inputs.forEach(({ input, id }) => { input.checked = !hidden.has(id); });
        if (control.all) { control.all.checked = shown === control.columns.length; control.all.indeterminate = shown > 0 && shown < control.columns.length; }
      },
      bind(key, columns, changed) {
        if (control.key !== key) control.close();
        const focused = !panel.hidden && panel.contains(document.activeElement) ? document.activeElement : null;
        const focusId = focused?.dataset.scheduleColumnChoice, focusAll = focused === control.all, scrollTop = panel.scrollTop;
        control.key = key; control.columns = columns; control.changed = changed;
        const label = document.createElement("label"), all = document.createElement("input"), caption = document.createElement("span");
        label.className = "schedule-column-all"; all.type = "checkbox"; all.dataset.scheduleSelectAll = "true"; text(caption, "Select all"); label.append(all, caption);
        all.addEventListener("change", () => {
          const hidden = new Set(read(key)); columns.forEach(column => all.checked ? hidden.delete(column.id) : hidden.add(column.id)); save(key, hidden);
        });
        control.all = all; control.inputs = []; panel.replaceChildren(label);
        for (const column of columns) {
          const item = document.createElement("label"), input = document.createElement("input"), caption = document.createElement("span");
          input.type = "checkbox"; input.dataset.scheduleColumnChoice = column.id; text(caption, column.label); item.append(input, caption);
          input.addEventListener("change", () => { const hidden = new Set(read(key)); input.checked ? hidden.delete(column.id) : hidden.add(column.id); save(key, hidden); });
          panel.append(item); control.inputs.push({ input, id: column.id });
        }
        control.refresh();
        if (focused) { (focusAll ? all : control.inputs.find(item => item.id === focusId)?.input || all).focus({ preventScroll: true }); panel.scrollTop = scrollTop; }
        return read(key);
      },
    };
    button.addEventListener("click", () => {
      if (!panel.hidden) return control.close();
      opened?.close(); document.body.append(panel); control.position(); panel.hidden = false; opened = control; button.setAttribute("aria-expanded", "true"); control.all?.focus({ preventScroll: true });
    });
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); control.close(true); }
      // The panel is portalled outside the scrolling page tabs. Keep Tab order
      // beside its toggle rather than sending it to the end of the document.
      if (event.key === "Tab") {
        const inputs = [control.all, ...control.inputs.map(item => item.input)], active = document.activeElement;
        if (event.shiftKey && active === inputs[0]) { event.preventDefault(); control.close(true); }
        else if (!event.shiftKey && active === inputs.at(-1)) { control.close(); button.focus(); }
      }
    });
    controls.add(control); return control;
  }
  function applyTable(table, hidden) {
    const layout = table.scheduleColumnLayout;
    if (!layout) return;
    const scroll = table.parentElement, retained = table.hidden && table.scheduleColumnsScroll;
    const left = retained ? retained.left : scroll?.scrollLeft, top = retained ? retained.top : scroll?.scrollTop;
    for (const cell of table.querySelectorAll("[data-schedule-column]")) cell.hidden = hidden.has(cell.dataset.scheduleColumn);
    const visible = layout.filter(column => !hidden.has(column.id)), colgroup = table.querySelector("colgroup");
    if (colgroup) colgroup.replaceChildren(...visible.map(column => { const col = document.createElement("col"); col.style.width = `${column.width}px`; return col; }));
    table.style.width = `${visible.reduce((sum, column) => sum + column.width, 0)}px`;
    for (const cell of table.querySelectorAll("[data-schedule-spacer]")) cell.colSpan = Math.max(1, visible.length);
    if (!visible.length) table.scheduleColumnsScroll = { left, top };
    else table.scheduleColumnsScroll = null;
    table.hidden = !visible.length;
    if (!table.scheduleColumnsEmpty && scroll) {
      const empty = document.createElement("p"); empty.className = "schedule-columns-empty helper"; text(empty, "Select a column to show the schedule."); scroll.append(empty); table.scheduleColumnsEmpty = empty;
    }
    if (table.scheduleColumnsEmpty) table.scheduleColumnsEmpty.hidden = Boolean(visible.length);
    if (scroll) {
      scroll.scrollLeft = left; scroll.scrollTop = top;
      // Hiding the entire table can clamp native scroll positions. Ignore only
      // this exact projection position; a different user scroll remains active.
      scroll.scheduleColumnProjection = { left: scroll.scrollLeft, top: scroll.scrollTop };
    }
  }
  const isProjectionScroll = target => Boolean(target?.scheduleColumnProjection
    && target.scrollTop === target.scheduleColumnProjection.top && target.scrollLeft === target.scheduleColumnProjection.left);
  window.addEventListener("pointerdown", event => { if (opened && !opened.host.contains(event.target) && !opened.panel.contains(event.target)) opened.close(); });
  window.addEventListener("keydown", event => { if (event.key === "Escape" && opened) { event.preventDefault(); opened.close(true); } });
  window.addEventListener("resize", () => opened?.position());
  window.addEventListener("scroll", event => {
    const target = event.target;
    if (!opened || isProjectionScroll(target) || target !== window && opened.panel.contains(target)) return;
    // Text inputs can scroll internally when a precise value blurs. That does
    // not move this disclosure. Page/tab scrolling moves its anchor instead.
    if (target === window || target === document || target.contains?.(opened.button)) opened.position();
    else if (target.matches?.("[data-schedule-viewport], .calculator-table-scroll, .table-scroll")) opened.close();
  }, true);
  return { create, applyTable, hidden: read, isProjectionScroll };
})();

(() => {
  const $ = (id) => document.getElementById(id);
  const calculationQueue = window.CeasefireCalculationQueue.create();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlExactNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 15 });
  const state = { list: null, listRequest: null, definitionRequests: new Map(), entries: new Map(), current: null, loadRevision: 0, requestRevision: 0, timer: null, action: false, calculating: false, optionLists: new Map(), optionKeys: new WeakMap(), nextListId: 0 };
  // Browser annotation scopes use immutable source coordinates. They change
  // alignment, labels and column order only; source identities stay unchanged.
  const browserPresentation = {
    steel_vermiculite: {
      START: { text: { A7: "Use SCHEDULE to enter members and SUMMARY to review product quantities. Open FACTOR CALCS for the Section Factor Helper." } },
      SCHEDULE: { column_order: ["Z", "AA", "A", "E", "F", "C", "D", "B", "H", "I", "J", "G"] },
      CALCULATOR: { hide: ["A1"], text: { A1: "" }, center: ["A6:F24", "H6:N24"], split_status: ["H9", "H20"] }, // 4–5
      BAGS: { center: ["A6:N15", "A19:I25"] }, // Manual quantities and all six product totals
      SETTINGS: {
        omit: ["A1", "A10:N12", "A15:N15", "A27:N27", "A292:L295", "A308:L315"],
        text: {
          A356: "HOLLOW SECTIONS",
          A273: "Select product, exposure, steel temperature and input method. Enter the exact section or verified factor. Lower-web input is only for Fendolite castellated beams.",
          A301: "Verify pack size, method and site yield for each product. The startup densities are estimating assumptions; verify product-specific site yield. Add waste separately. See the historical product yield-source records on SETTINGS.",
        },
        center: ["A10:L15", "A54:L58", "A86:L90", "A123:L167", "A196:L223", "A259:L264"], // 10–11, 17–20
        left: ["D36:F41", "D69:F74", "D101:F106", "D178:F183", "D234:F239", "D561:F566"], // Product quantity settings
      },
    },
    steel_intumescent: {
      SCHEDULE: { column_order: ["Z", "AA", "A", "E", "F", "C", "D", "B", "H", "I", "J", "G"] },
      SETTINGS: {
        omit: ["A4:D4", "A6:D8", "A12:D13", "A15:D15", "A18:D20", "A26:H30", "A34:F34", "A48:F52", "A64:H64", "A86:H93"],
        text: { A36: "Nominal mixed density estimate (kg/L)" },
        control_labels: { F36: "Nominal mixed density estimate (kg/L)" },
      },
    },
    steel_board: {
      CALCULATOR: {
        omit_columns: ["L"], schedule_omit_columns: ["Y", "AA", "AC", "AD"],
        column_order: ["A", "B", "C", "D", "F", "CJ", "G", "H", "I", "J", "K", "E"],
        text: { AE8: "Board net (m2)", AG8: "Sheets", AH8: "Purchase area (m2)" },
      }, // Retain source inputs, calculated outputs and saved row waste.
      START: { hide: ["A1"], text: { A1: "", D13: "Previously saved additional-board allowances remain included in purchasing totals.", A27: "Use START, SCHEDULE, BOARD SUMMARY and SETTINGS. Supporting reference data is retained by the application.", A31: "Saved additional-board allowances remain included in the board summary." } },
      "BOARD SUMMARY": { center: ["A11:D29", "I11:J29"], text: { A1: "SUMMARY" } }, // 22
      SETTINGS: { center: ["A5:C34", "G5:N10"], text: { Q5: "Description" }, omit: ["A1", "A3"] }, // 23–25
    },
    ductwork: {
      CALCULATOR: { column_order: ["A", "B", "D", "CM", "E", "H", "I", "F", "G", "C"], text: { A3: "For FyreWrap, Internal, External and Both use the exhaust application rules. Select pressurisation separately." } },
      SUMMARY: { center: ["A8:J11"], text: { A17: "PENETRATION ANGLES" }, omit: ["A4:L5", "A14:L15", "A17:L45"] }, // Retain source tables and notes in worksheet data and exports.
      "PRODUCT SETTINGS": {
        omit: ["A1", "A8:H24", "A26:H34", "A36:H43", "A50:H64", "A66:H67", "A70:H72", "A74:H89", "A101:H110", "A113:H151", "J115:Q149"],
        omit_section_notes: ["A6", "A48", "A94", "J115"],
        omit_table_notes: ["J94"],
        center: ["A36:H39", "B7:D35", "B44:D46", "B90:D92", "A74:H79", "B49:D73", "B95:D115",
          "A117:H121", "A123:H127", "A129:H134", "A136:H141", "J95:Q104", "J116:Q130"], // 31–43
      },
    },
  };
  // Fixed interface labels in immutable workbook presentation cells. Match both
  // source coordinates and original text; formula results, products and draft values
  // retain their canonical text even when it happens to equal a translated label.
  const calculatorLabelSources = {
    "steel_intumescent": { "SETTINGS": { "A36": "Transport-weight density estimate (kg/L)" } },
    "steel_vermiculite": {
      "CALCULATOR": {
        "A1": "CEASEFIRE  |  STEEL FIRE PROTECTION",
        "A5": "01  INPUTS",
        "H5": "02  THICKNESS & QUANTITIES",
        "A6": "Product",
        "A7": "Exposure / member case",
        "A8": "Critical temperature (°C)",
        "A9": "Input method",
        "A10": "Steel section ID",
        "A11": "Hp/A | ESA/M | lower web mm",
        "A12": "Fire-resistance period (min)",
        "H12": "Lookup ESA/M (m²/t)",
        "H13": "Lookup Hp/A (m⁻¹)",
        "A14": "Quantity of members",
        "H14": "Usable estimating thickness (mm)",
        "A15": "Length per member (m)",
        "H15": "Girth used (m)",
        "A16": "Girth override (m)",
        "H16": "Spray area (m²)",
        "A17": "Area override (m²)",
        "H17": "Coating volume (m³)",
        "H18": "Net bags",
        "A26": "03  ALL PUBLISHED PERIODS FOR THIS INPUT",
        "A28": "Minutes"
      },
      "SCHEDULE": {
        "B9": "Product",
        "C9": "Exposure / member case",
        "E9": "Input method",
        "Q9": "Girth used (m)",
        "K9": "Girth override (m)",
        "R9": "Spray area (m²)",
        "L9": "Area override (m²)",
        "S9": "Coating volume (m³)",
        "T9": "Net bags",
        "A4": "TOTAL ENTERED SPRAY AREA",
        "G4": "COATING VOLUME QUANTIFIED",
        "M4": "THICKNESS / SCOPE BLOCKS",
        "S4": "ROWS NOT FULLY QUANTIFIED",
        "A9": "Item / mark",
        "D9": "Critical temp (°C)",
        "F9": "Section ID",
        "G9": "Hp/A | ESA/M | web mm",
        "H9": "Fire period (min)",
        "I9": "Quantity",
        "J9": "Length / member (m)",
        "M9": "Lookup ESA/M",
        "N9": "Lookup Hp/A",
        "O9": "Published thickness (mm)",
        "P9": "Estimating thickness (mm)",
        "U9": "Whole bags incl. waste",
        "V9": "Thickness status",
        "W9": "Quantity status",
        "X9": "Thickness source",
        "Y9": "Basis / review note",
        "Z9": "Line ID",
        "AA9": "Location"
      },
      "BAGS": {
        "A6": "Product",
        "A19": "Product",
        "A9": "Coating volume (m³)",
        "A12": "Net bags",
        "E19": "Net bags",
        "A13": "Whole bags incl. waste",
        "A1": "CEASEFIRE  |  MATERIAL QUANTITIES",
        "A7": "Area (m²)",
        "A8": "Manual thickness (mm)",
        "A10": "Yield used (m³/bag)",
        "A11": "Waste allowance",
        "A14": "Coverage (m²/bag)",
        "A17": "PRODUCT ORDER SUMMARY",
        "B19": "Schedule lines",
        "C19": "Area entered (m²)",
        "D19": "Volume quantified (m³)",
        "F19": "Waste",
        "G19": "Whole bags / product",
        "H19": "Incomplete rows",
        "I19": "Order status"
      },
      "SETTINGS": {
        "A39": "Waste allowance",
        "A72": "Waste allowance",
        "A104": "Waste allowance",
        "A181": "Waste allowance",
        "A237": "Waste allowance",
        "A564": "Waste allowance",
        "A569": "Spray application basis",
        "A570": "Spray application basis",
        "K5": "COMMON RULES",
        "A9": "01  /  GLOBAL SETTINGS",
        "A10": "Project reference",
        "A11": "Engineer / design reference",
        "A12": "Project design release",
        "A13": "Steel density",
        "A14": "Factor lookup policy",
        "A43": "Factor lookup policy",
        "A76": "Factor lookup policy",
        "A108": "Factor lookup policy",
        "A185": "Factor lookup policy",
        "A241": "Factor lookup policy",
        "A15": "Comparison tolerance",
        "A17": "02  /  COMMON CALCULATION RULES",
        "A19": "Lookup method",
        "A21": "Thickness & holds",
        "A23": "Material yield",
        "A25": "Quantities & orders",
        "A27": "Project design",
        "A35": "PARAMETER",
        "A68": "PARAMETER",
        "A100": "PARAMETER",
        "A177": "PARAMETER",
        "A233": "PARAMETER",
        "A560": "PARAMETER",
        "D35": "VALUE",
        "D68": "VALUE",
        "D100": "VALUE",
        "D177": "VALUE",
        "D233": "VALUE",
        "D560": "VALUE",
        "G35": "BASIS / EFFECT",
        "G68": "BASIS / EFFECT",
        "G100": "BASIS / EFFECT",
        "G177": "BASIS / EFFECT",
        "G233": "BASIS / EFFECT",
        "G560": "BASIS / EFFECT",
        "A36": "Bag mass",
        "A69": "Bag mass",
        "A101": "Bag mass",
        "A178": "Bag mass",
        "A234": "Bag mass",
        "A561": "Bag mass",
        "A37": "Verified direct yield",
        "A38": "Estimating density",
        "A71": "Estimating density",
        "A103": "Estimating density",
        "A180": "Estimating density",
        "A236": "Estimating density",
        "A563": "Estimating density",
        "A40": "Yield used",
        "A73": "Yield used",
        "A105": "Yield used",
        "A182": "Yield used",
        "A238": "Yield used",
        "A565": "Yield used",
        "A41": "Material status",
        "A74": "Material status",
        "A106": "Material status",
        "A183": "Material status",
        "A239": "Material status",
        "A566": "Material status",
        "A42": "Material basis / reference",
        "A75": "Material basis / reference",
        "A107": "Material basis / reference",
        "A184": "Material basis / reference",
        "A240": "Material basis / reference",
        "A567": "Material basis / reference",
        "A45": "Product scope",
        "A78": "Product scope",
        "A110": "Product scope",
        "A187": "Product scope",
        "A243": "Product scope",
        "A568": "Product scope",
        "A46": "Consumption evidence",
        "A79": "Consumption evidence",
        "A111": "Consumption evidence",
        "A188": "Consumption evidence",
        "A244": "Consumption evidence",
        "A48": "TECHNICAL RULES & SOURCE-REVIEW DEFINITIONS",
        "A81": "TECHNICAL RULES & SOURCE-REVIEW DEFINITIONS",
        "A113": "TECHNICAL RULES & SOURCE-REVIEW DEFINITIONS",
        "A190": "TECHNICAL RULES & SOURCE-REVIEW DEFINITIONS",
        "A246": "TECHNICAL RULES & SOURCE-REVIEW DEFINITIONS",
        "A50": "Named-section route",
        "A83": "Named-section route",
        "A192": "Named-section route",
        "A51": "ESA/M input basis",
        "A84": "ESA/M input basis",
        "A193": "ESA/M input basis",
        "A54": "EXPOSURE / MEMBER CASE",
        "A86": "EXPOSURE / MEMBER CASE",
        "A123": "EXPOSURE / MEMBER CASE",
        "A196": "EXPOSURE / MEMBER CASE",
        "A259": "EXPOSURE / MEMBER CASE",
        "D54": "TEMP °C",
        "D86": "TEMP °C",
        "D123": "TEMP °C",
        "D196": "TEMP °C",
        "D259": "TEMP °C",
        "E54": "Hp/A MIN",
        "E86": "Hp/A MIN",
        "E123": "Hp/A MIN",
        "E196": "Hp/A MIN",
        "E259": "Hp/A MIN",
        "F54": "Hp/A MAX",
        "F86": "Hp/A MAX",
        "F123": "Hp/A MAX",
        "F196": "Hp/A MAX",
        "F259": "Hp/A MAX",
        "G54": "PUBLISHED PERIODS (MIN)",
        "G86": "PUBLISHED PERIODS (MIN)",
        "G123": "PUBLISHED PERIODS (MIN)",
        "G196": "PUBLISHED PERIODS (MIN)",
        "G259": "PUBLISHED PERIODS (MIN)",
        "J54": "FACTOR BASIS",
        "J86": "FACTOR BASIS",
        "J123": "FACTOR BASIS",
        "J196": "FACTOR BASIS",
        "J259": "FACTOR BASIS",
        "L54": "STATUS",
        "L86": "STATUS",
        "L123": "STATUS",
        "L196": "STATUS",
        "L259": "STATUS",
        "A70": "Direct estimating yield",
        "A102": "Direct estimating yield",
        "A179": "Direct estimating yield",
        "A235": "Direct estimating yield",
        "A562": "Direct estimating yield",
        "A115": "Lower-web numerator",
        "A116": "Castellated maximum",
        "A248": "Factor-label gap: above",
        "A249": "Factor-label gap: below",
        "A270": "08  /  COMPLETE WORKBOOK OPERATING RULES",
        "A272": "START HERE",
        "A276": "READ THE RESULT",
        "A280": "FACTOR LOOKUP POLICY",
        "A284": "NAMED MEMBERS AND SHARED FACTORS",
        "A288": "SCOPE AND HOLLOW SECTIONS",
        "A292": "SCHEDULE AND SORTING",
        "A296": "QUANTITIES",
        "A300": "BAG YIELDS AND ORDERS",
        "A308": "PROJECT RELEASE",
        "A312": "SOURCE CONTROL AND QUALITY",
        "A341": "FACTOR HELPER  |  Hp/A AND ESA/M",
        "A346": "Heated perimeter (m)",
        "A365": "Heated perimeter (m)",
        "A347": "Steel area (mm²)",
        "A364": "Steel area (mm²)",
        "A348": "Mass per metre (kg/m)",
        "A350": "Hp/A from steel area (m⁻¹)",
        "A351": "ESA/M from mass (m²/t)",
        "A356": "IDEALISED HOLLOW GEOMETRY  |  Approximate helper; no corner radii or manufacturing tolerances.",
        "A358": "Shape",
        "A359": "Depth / outside diameter (mm)",
        "A360": "Width (mm)",
        "A361": "Wall thickness (mm)",
        "A362": "Exposed sides",
        "A372": "Lower-web thickness (mm)",
        "A373": "Special Hp/A (m⁻¹)",
        "A7": "CALCULATOR = one member  |  SCHEDULE = take-off  |  BAGS = ordering  |  Factor helper starts at row 341.",
        "A273": "Use CALCULATOR for one member or SCHEDULE for up to 1,000 lines. Select product, exposure, steel temperature and input method. Enter the exact section or verified factor. Lower-web input is only for Fendolite castellated beams.",
        "A277": "Read the visible result note before using estimating thickness. Excluded or unpublished cases return no bags. Published values and estimating replacements are not project design approval.",
        "A293": "Sort or filter the entire SCHEDULE table, never one column alone. Keep the hidden Line ID unchanged. Use the 1,000 prepared rows; more rows require extending ENGINE.",
        "A301": "Verify pack size, method and site yield for each product. CAFCO uses an inherited assumption; Mandolite is provisional; Fendolite/Perlifoc are theoretical; Monokote is uninjected. Add waste separately. Sources: P330:V333.",
        "A309": "Have the designer confirm the member, exposure, steel temperature, substrate, fixings, application and thickness. Record the design references here. This estimator does not certify the fire design.",
        "A313": "The workbook records the supplied report editions, not verified current validity. Review the complete signed reports for the project. AUDIT retains the source decisions and validation checks."
      }
    },
    "steel_board": {
      "START": {
        "A8": "01  EVERYDAY WORKFLOW",
        "A9": "CALCULATOR",
        "A10": "NORMAL INPUTS A:L",
        "A11": "MAIN RESULTS Y:AI",
        "A12": "BOARD SUMMARY",
        "A13": "EXTRA BOARDS",
        "A15": "02  HOW BOARD AREA IS CALCULATED",
        "A21": "03  SAFETY AND SCOPE",
        "A25": "04  OPTIONAL CONTROLS AND MAINTENANCE",
        "A30": "05  HOW TO READ THE ROW NOTES",
        "D9": "Replace or clear the demonstration rows. Enter one member, or one group of identical members, per row. 200 prepared rows: 9–208. Enter the TOTAL lineal length for that row.",
        "D10": "Product; Steel ID OR ESA/M; lineal metres; exposed sides; FRL; Beam/Column; critical temperature; family for manual ESA input; wastage. FRL and temperature dropdowns follow the selected product/member.",
        "D11": "Read Row status (AI) for the actual issue and next action. No quantity = this row is excluded from purchasing. Warnings with a quantity state the checks or extra boards still needed. AD is reference box area only; AE/AF are actual board quantities.",
        "D12": "Use the whole-job pooled quantities for purchasing, not the sum of standalone line-sheet counts. Filtered-out schedule rows remain in the whole-job total. Stock is separated by product and actual board thickness.",
        "D13": "This hidden input sheet retains measured noggings, soldiers, cover strips, closures and coatbacks. Valid allowances still feed BOARD SUMMARY. Right-click a sheet tab and choose Unhide to enter them.",
        "A26": "Unhide M:X for advanced inputs. M:Q controls layout, layers, lookup and installation detail. R/S = depth/width; T = area; U = mass; V = INSIDE box girth; W = added girth; X = design reference. AI gives the action directly. AJ:AV retains detailed outputs and notes.",
        "A27": "Only START, CALCULATOR and BOARD SUMMARY are visible. Supporting data sheets remain embedded and hidden. Do not delete them. Library edits must also update the generated geometric lookup prefix. This release rebuilds and checks every prefix while preserving the native fire-design suffixes.",
        "A28": "Capacity is 200 prepared rows. For a larger job, extend inside the table, copy ALL formula columns Y:CI and check dropdowns and purchasing ranges. Do not assume typing below row 208 automatically extends every summary formula.",
        "A31": "Example: 'Confirm 620 C for this 2-sided beam' means ask the structural designer to confirm the critical temperature for that exposure. 'Add support boards separately' means the displayed board area excludes those supports; enter the measured allowance on the hidden EXTRA BOARDS sheet."
      },
      "CALCULATOR": {
        "A1": "CEASEFIRE  /  STRUCTURAL STEEL BOARD SCHEDULE",
        "A4": "SCHEDULE ROWS",
        "E4": "WITH BOARD QUANTITIES",
        "I4": "INCOMPLETE / NO QUANTITY",
        "Y4": "BOX REFERENCE m2",
        "AC4": "NET BOARD REQUIRED m2",
        "AG4": "POOLED JOB SHEETS",
        "A8": "Member mark",
        "B8": "Location",
        "C8": "Product",
        "D8": "Steel ID",
        "E8": "ESA/M input (m2/t)",
        "F8": "Lineal metres",
        "G8": "Sides",
        "H8": "FRL required (min)",
        "I8": "Beam or Column",
        "J8": "Critical temp (C)",
        "K8": "Family (ESA input)",
        "L8": "Waste (%)",
        "M8": "Exposure layout",
        "N8": "Partial depth (mm)",
        "O8": "Layer preference",
        "P8": "Thickness lookup",
        "Q8": "Installation detail",
        "R8": "Depth or OD (mm)",
        "S8": "Width B (mm)",
        "T8": "Steel area (cm2)",
        "U8": "Steel mass (kg/m)",
        "V8": "Box girth override (m)",
        "W8": "Added girth (m)",
        "X8": "Design reference",
        "Y8": "ESA/M used (m2/t)",
        "Z8": "Board stack (mm)",
        "AA8": "Layers",
        "AB8": "Total thickness (mm)",
        "AC8": "Bare box girth (m)",
        "AD8": "Box reference area (m2)",
        "AE8": "Board required - net (m2)",
        "AF8": "Board incl waste (m2)",
        "AG8": "Sheets - this line",
        "AH8": "Purchase area - line (m2)",
        "AI8": "Row status",
        "AJ8": "Layer 1 (mm)",
        "AK8": "Layer 2 (mm)",
        "AL8": "Layer 1 board area (m2)",
        "AM8": "Layer 2 board area (m2)",
        "AN8": "Design period (min)",
        "AO8": "Critical temp used (C)",
        "AP8": "Fire-design HpA (1/m)",
        "AQ8": "Inside cladding girth (m)",
        "AR8": "Quantity status",
        "AS8": "Design status",
        "AT8": "Thickness source",
        "AU8": "Geometry source",
        "AV8": "Notes and conditions",
        "AW8": "Published requirement (mm)",
        "AX8": "HpA benchmark (1/m)",
        "AY8": "Waste used",
        "AZ8": "Layer 1 with waste (m2)",
        "BA8": "Layer 2 with waste (m2)",
        "BB8": "Source data flag",
        "BC8": "Quantity review flag",
        "BD8": "Active",
        "BE8": "Product code",
        "BF8": "Steel index",
        "BG8": "Section family used",
        "BH8": "Lookup basis used",
        "BI8": "Layer preference used",
        "BJ8": "Layout used",
        "BK8": "Installation detail used",
        "BL8": "Depth used (mm)",
        "BM8": "Width used (mm)",
        "BN8": "Area used (cm2)",
        "BO8": "Thermal girth (m)",
        "BP8": "Factor record position",
        "BQ8": "Base HpA (1/m)",
        "BR8": "Input error",
        "BS8": "Section design key",
        "BT8": "Section design position",
        "BU8": "Rule index",
        "BV8": "System ID",
        "BW8": "System index",
        "BX8": "Added girth used (m)",
        "BY8": "Corner count",
        "BZ8": "Sheet area (m2)",
        "CA8": "Base system ID",
        "CB8": "Native design chosen",
        "CC8": "Geometry override used",
        "CD8": "Source group",
        "CE8": "Steel lookup record",
        "CF8": "Section lookup record",
        "CG8": "Duration lookup record",
        "CH8": "Rule lookup map",
        "CI8": "Selected rule record"
      },
      "BOARD SUMMARY": {
        "A11": "Product",
        "A1": "CEASEFIRE  /  BOARD TAKEOFF",
        "A5": "NET BOARD REQUIRED (m2)",
        "E5": "WHOLE SHEETS",
        "I5": "PURCHASE AREA (m²)",
        "B11": "Board mm",
        "C11": "Sheet length mm",
        "D11": "Sheet width mm",
        "E11": "Box board - net m2",
        "F11": "Extra boards - net m2",
        "G11": "Net total sqm",
        "H11": "With waste sqm",
        "I11": "Whole sheets",
        "J11": "Purchase sqm",
        "K11": "Stock source",
        "L11": "Board key"
      },
      "EXTRA BOARDS": {
        "B5": "Product",
        "K5": "With waste sqm",
        "L5": "Board key",
        "A1": "EXTRA BOARDS  /  DETAIL TAKEOFF",
        "A5": "Item",
        "M5": "Status"
      },
      "SETTINGS": {
        "A1": "SETTINGS & CONVENTIONS",
        "A5": "Setting",
        "B5": "Value",
        "C5": "Units",
        "D5": "Basis",
        "K5": "No selection",
        "L5": "Column temp (C)",
        "M5": "P100 beam temp (C)",
        "N5": "Other beam temp (C)",
        "P5": "Existing diagnostic code",
        "Q5": "Plain-English message (display only)",
        "A6": "Nominal steel density",
        "A7": "Kilograms per tonne",
        "A8": "Millimetres per metre",
        "A9": "Square centimetres per square metre",
        "A10": "Default board wastage",
        "A11": "COREX first general HpA row",
        "A12": "XS beam noggin protrusion per side",
        "A13": "Default column critical temperature",
        "A14": "Default beam critical temperature",
        "A15": "P100/P250 standard detail maximum depth",
        "A16": "P100/P250 standard detail maximum width",
        "A17": "XS beam maximum height stated",
        "A18": "XS top-of-wall single layer minimum",
        "A19": "XS top-of-wall minimum steel width",
        "A20": "Unfilled trapezoid 90 minute HpA multiplier",
        "A21": "Boundary numerical tolerance",
        "A23": "COREX assessment maximum Hp/A",
        "A24": "COREX assessment maximum depth",
        "A25": "COREX single-layer maximum thickness",
        "A26": "COREX maximum two-layer total",
        "A27": "COREX single-layer maximum period",
        "A28": "COREX 120-minute maximum published Hp/A",
        "A29": "COREX 180-minute / 620 C maximum Hp/A",
        "A30": "COREX 180-minute / 550 C stock maximum Hp/A",
        "A31": "COREX 90-minute / 550 C maximum published Hp/A",
        "A32": "COREX upper-band lower boundary",
        "A33": "COREX 90-minute / 550 C upper-band stock",
        "A34": "COREX 120-minute / 550 C upper-band stock"
      }
    },
    "ductwork": {
      "CALCULATOR": {
        "A1": "CEASEFIRE | DUCT PROTECTION CALCULATOR • V5.5.2",
        "A10": "Line",
        "B10": "Duct size W x H (mm)",
        "C10": "Product",
        "D10": "Length (m)",
        "E10": "FRL — compartment / duct*",
        "F10": "Wall penetrations",
        "G10": "Floor penetrations",
        "H10": "Fire exposure / FyreWrap application",
        "I10": "Orientation",
        "J10": "STATUS / ESTIMATING BASIS",
        "K10": "Duct surface (m²)",
        "L10": "Spray DFT (mm)",
        "M10": "Net bags — body only",
        "N10": "Net wrap material (m²)",
        "O10": "Net roll equivalents",
        "P10": "Maxilite net @60 mm (m²)",
        "Q10": "Wrap fixing method",
        "R10": "Continuous wrap layers",
        "S10": "Wall L2 each side (m)",
        "T10": "Floor L2 top (m)",
        "U10": "Floor L3 top (m)",
        "V10": "L1 material (m²)",
        "W10": "L2 material (m²)",
        "X10": "L3 material (m²)",
        "Y10": "Maxilite width (mm)",
        "Z10": "Maxilite strips (lm)",
        "AA10": "Cut board strips (not sheets)",
        "AB10": "Cross-strip cut (mm)",
        "AC10": "Side-strip cut (mm)",
        "AD10": "Wall angle profile",
        "AE10": "Wall angle net / allowance (lm)",
        "AF10": "Floor TOP profile",
        "AG10": "Floor TOP net / allowance (lm)",
        "AH10": "Floor BOTTOM profile",
        "AI10": "Floor BOTTOM net / allowance (lm)",
        "AJ10": "Combined angle length (lm)",
        "AK10": "Penetration clearance guide",
        "AL10": "Penetration fixing guide",
        "AM10": "Body fixing / support guide",
        "AN10": "Spray body volume (m³)",
        "AO10": "Working yield (m³/bag)",
        "AS10": "Active",
        "BD10": "Product code"
      },
      "SUMMARY": {
        "A8": "Product",
        "A18": "Product",
        "A30": "Product",
        "B8": "Rows",
        "C8": "Duct area (m²)",
        "D8": "Net bags",
        "E8": "Wrap (m²)",
        "F8": "Roll eq.",
        "G8": "Maxilite (m²)",
        "H8": "Angles (lm)",
        "I8": "Primary qty withheld",
        "J8": "Steel rows withheld",
        "K8": "Basis",
        "D30": "Basis",
        "I39": "Basis",
        "L8": "Interpretation",
        "F30": "Interpretation",
        "A17": "PENETRATION ANGLES — LENGTH BY SIZE AND LOCATION",
        "B18": "Location",
        "C18": "Profile (mm)",
        "D18": "Length (lm)",
        "E18": "Quantity basis",
        "F18": "Limitation",
        "A29": "WORKING YIELDS — CALIBRATED OR UNCALIBRATED",
        "B30": "Working m³/bag",
        "C30": "Reference quantity",
        "E30": "Source",
        "A38": "MAXILITE — 60 mm BOARD AREA AND CUT STRIPS",
        "A39": "Strip width (mm)",
        "B39": "Wall board (m²)",
        "C39": "Floor TOP (m²)",
        "D39": "Floor BOTTOM (m²)",
        "E39": "Total board (m²)",
        "F39": "Cut strips (pieces)",
        "G39": "Cut strip length (lm)",
        "H39": "Area identity check"
      },
      "PRODUCT SETTINGS": {
        "D7": "Basis",
        "D49": "Basis",
        "D95": "Basis",
        "H36": "Interpretation",
        "G36": "Source",
        "F74": "Source",
        "G123": "Source",
        "G129": "Source",
        "J6": "BOTH / MIXED — USE THE STRICTER CASE",
        "A7": "Parameter",
        "A49": "Parameter",
        "A95": "Parameter",
        "J116": "Parameter",
        "B7": "Value",
        "B49": "Value",
        "B95": "Value",
        "K116": "Value",
        "C7": "Units",
        "C49": "Units",
        "C95": "Units",
        "L116": "Units",
        "E7": "Source / interpretation",
        "E49": "Source / interpretation",
        "E95": "Source / interpretation",
        "M116": "Source / interpretation",
        "A36": "Width band",
        "B36": "Height max (mm)",
        "C36": "Hanger rods",
        "D36": "Spacing (mm)",
        "E36": "Bottom support",
        "F36": "Stiffener",
        "A74": "Key",
        "A117": "Key",
        "A129": "Key",
        "A136": "Key",
        "B74": "Complete FRL",
        "C74": "Internal (mm)",
        "D74": "External (mm)",
        "E74": "Max size",
        "G74": "Selection",
        "H74": "Notes",
        "J94": "FYREWRAP APPLICATION TABLE • MANUAL pp.8–9",
        "J95": "Calculator H selection",
        "K95": "Manual application wording",
        "L95": "Family",
        "M95": "Continuous layers",
        "N95": "External FRL (2h table)",
        "O95": "Internal FRL (2h table)",
        "P95": "Source page",
        "Q95": "Scope / distinction",
        "J115": "PENETRATION TAKEOFF — STANDARD FOUR-SIDED DETAILS",
        "B117": "Duct max (mm)",
        "C117": "Gap min (mm)",
        "D117": "Gap max (mm)",
        "E117": "Board width (mm)",
        "F117": "Angle (mm)",
        "G117": "Board thick (mm)",
        "H117": "Source / scope",
        "J117": "Wall board collars",
        "L117": "faces/wall",
        "A123": "Wall type",
        "B123": "Angle to wall",
        "C123": "Board to wall",
        "D123": "Max c/c (mm)",
        "E123": "Angle to duct",
        "F123": "Pin specification",
        "H123": "Scope",
        "H129": "Scope",
        "J123": "Cut strips per collar",
        "L123": "strips",
        "B129": "Printed WIDTH",
        "B136": "Printed WIDTH",
        "C129": "Printed HEIGHT",
        "C136": "Printed HEIGHT",
        "D129": "60-min L2 (mm)",
        "E129": "120-min L2 (mm)",
        "D136": "120-min L2 (mm)",
        "F129": "Selection order",
        "J129": "Corner treatment",
        "K129": "Count once",
        "L129": "geometry",
        "E136": "120-min L3 (mm)",
        "F136": "180-min L2 (mm)",
        "G136": "180-min L3 (mm)",
        "H136": "Source / priority",
        "A8": "Assessed spray thickness",
        "A9": "Internal / vertical FRL ceiling",
        "A10": "External horizontal FRL ceiling",
        "A11": "Horizontal maximum WIDTH",
        "A12": "Horizontal maximum HEIGHT",
        "A13": "Larger-than-tested trigger",
        "A14": "Duct base metal thickness",
        "A15": "Horizontal hanger interval",
        "A16": "Vertical standard support interval",
        "A17": "Vertical oversized / lightweight",
        "A18": "Concrete floor thickness",
        "A19": "Concrete floor nominal density",
        "A20": "Duct protection dried density",
        "A21": "Generic TDS reference density",
        "A22": "Bag mass",
        "A23": "Generic theoretical coverage",
        "A24": "Coverage reference thickness",
        "A25": "Working net yield — DUCTS",
        "A26": "Working coverage at 60 mm",
        "A27": "Wall capping angle",
        "A28": "Concrete floor TOP angle",
        "A29": "Concrete floor BOTTOM angle",
        "A30": "Wall angle frames",
        "A31": "Floor frames — each profile",
        "A32": "AAC / Speedpanel companion boards",
        "A33": "Removed site inputs",
        "A34": "Net spray quantity convention",
        "A35": "Yield basis",
        "A73": "Yield basis",
        "A37": "Up to 1200 mm",
        "A41": "Yield source URL",
        "A42": "Assessment source",
        "A88": "Assessment source",
        "A43": "CAFCO yield interpretation",
        "A44": "Calibration reference area",
        "A90": "Calibration reference area",
        "A45": "Calibration reference thickness",
        "A91": "Calibration reference thickness",
        "A46": "Calibration target net bags",
        "A92": "Calibration target net bags",
        "A50": "Maximum duct width / height",
        "A51": "Stability / integrity ceiling",
        "A52": "Insulation ceiling",
        "A53": "Small duct maximum width",
        "A54": "Small duct maximum height",
        "A55": "Medium duct maximum dimension",
        "A56": "Small duct minimum BMT",
        "A57": "Other duct minimum BMT",
        "A58": "Horizontal hanger spacing",
        "A59": "Vertical intermediate-support trigger",
        "A60": "Standard concrete floor thickness",
        "A61": "Standard penetration clearance",
        "A62": "Larger-duct wall stiffener",
        "A63": "Wall perimeter frame allowance",
        "A64": "Floor perimeter frame allowance",
        "A65": "Spray application basis",
        "A66": "Un-injected nozzle yield",
        "A67": "Injected nozzle yield",
        "A68": "Board-foot volume",
        "A69": "Working net yield",
        "A70": "GCP AU published MK-6/HY bag",
        "A81": "Standard wall basis",
        "A82": "Standard floor basis",
        "A83": "Spray scope",
        "A85": "Yield chart URL",
        "A86": "Local duct manual URL",
        "A87": "GCP AU TDS URL",
        "A89": "Application choice",
        "A96": "Blanket layer thickness",
        "A97": "Selected roll width",
        "A98": "Roll length",
        "A99": "Required wrap overlap",
        "A100": "Board strip butt-joint gap",
        "A101": "Maxilite thickness",
        "A102": "Wall collars / local zones",
        "A103": "Floor local-WRAP zones",
        "A104": "Band maximum centres",
        "A105": "Pin grid maximum centres",
        "A106": "Banding-only size threshold",
        "A107": "Band + one-face pins limit",
        "A108": "Supplied table dimension envelope",
        "A109": "External support example envelope",
        "A110": "Complete duct FRL auto-schedule",
        "A111": "Added waste / error allowance",
        "A112": "Selected actual roll area",
        "A113": "Width / height lookup convention",
        "A114": "Local layer count basis",
        "A115": "Standard penetration basis"
      }
    }
  };

  const browserAlignmentRanges = new WeakMap();
  function browserCellDisplay(entry, address, source = {}) {
    const rules = browserPresentation[entry.definition.id]?.[entry.sheet];
    if (!rules) return source;
    const position = parseAddress(address);
    if (!position) return source;
    if (!browserAlignmentRanges.has(rules)) browserAlignmentRanges.set(rules,
      Object.fromEntries(["left", "center"].map((align) => [align, (rules[align] || []).map((range) => range.split(":").map(parseAddress))])));
    const ranges = browserAlignmentRanges.get(rules), inside = ([start, end]) => {
      return position.row >= start.row && position.row <= end.row && position.column >= start.column && position.column <= end.column;
    };
    const align = ranges.left.some(inside) ? "left" : ranges.center.some(inside) ? "center" : source.align;
    return align === source.align ? source : { ...source, align };
  }
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
      SCHEDULE: { A3: [["filter or sort the complete table", "all rows are available on this page"]], A8: [["Paste your steel schedule here; blue cells are editable.", "Enter the schedule inputs, or use Import Schedule."]] },
      BAGS: { A27: [["The factor helper is also there.", "Open FACTOR CALCS for factor helpers."], ["Hidden reference sheets support the calculations and must not be deleted.", "Retained reference data supports the calculations."]] },
      SETTINGS: {
        A3: [["blue cells are editable", "input fields are editable"]],
        A7: [["CALCULATOR = one member", "SCHEDULE = members"], ["  |  SCHEDULE = take-off", ""], ["BAGS = ordering", "SUMMARY = ordering"], ["Factor helper starts at row 341.", "Open FACTOR CALCS for the Section Factor Helper."]],
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
        A301: [["CAFCO uses an inherited assumption;", "The original CAFCO workbook used an inherited assumption; new estimates use user-selected consumption settings."], ["Mandolite is provisional; Fendolite/Perlifoc are theoretical; Monokote is uninjected.", "The startup densities are estimating assumptions; verify product-specific site yield."], ["Sources: P330:V333.", "See the historical product yield-source records on SETTINGS."]],
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
        A6: [["Only START, CALCULATOR and BOARD SUMMARY are visible. See START for optional columns and hidden supporting sheets.", "Use START for guidance, BOARD SUMMARY for purchasing, and SETTINGS for configuration. Previously saved additional-board allowances remain included."]],
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
  const dirty = (entry) => JSON.stringify(entry.inputs) !== entry.saved || JSON.stringify(entry.scheduleRows) !== entry.savedRows;
  const scheduleWindowSize = 60, scheduleRowHeight = 96, scheduleBuffer = 12;
  const scheduleFor = (entry) => entry.definition.schedule?.sheet === entry.sheet ? entry.definition.schedule : null;
  const scheduleState = (entry) => Array.isArray(entry.scheduleRows) ? { schedule_rows: [...entry.scheduleRows] } : {};

  function scheduleChanged(entry) {
    entry.revision++; entry.pendingResult = null; entry.navigationCache = null; entry.needsRender = true;
    clearTimeout(state.timer); ++state.requestRevision; updateStatus(entry);
  }

  function scheduleEditableAddresses(entry, row) {
    const schedule = entry.definition.schedule;
    const columns = (schedule.columns || []).filter((column) => column.editable && !column.generated && column.column !== schedule.line_id_column).map((column) => columnName(columnNumber(column.column)));
    return [...new Set([...columns.map((column) => `${column}${row}`), ...Object.keys(entry.inputs[schedule.sheet] || {}).filter((address) => parseAddress(address)?.row === row && columnName(parseAddress(address).column) !== schedule.line_id_column)])];
  }

  async function addScheduleRow(entry = current()) {
    if (!entry || entry !== current() || state.action || entry.invalid.size || !Array.isArray(entry.scheduleRows)) return;
    const schedule = entry.definition.schedule, used = new Set(entry.scheduleRows);
    let row = schedule.first_row;
    while (used.has(row) && row <= schedule.last_row) row++;
    if (row > schedule.last_row) return;
    entry.inputs[schedule.sheet] ||= {};
    for (const address of scheduleEditableAddresses(entry, row)) entry.inputs[schedule.sheet][address] = null;
    entry.scheduleRows = [...entry.scheduleRows, row].sort((left, right) => left - right);
    entry.removedRows = [];
    const index = entry.scheduleRows.indexOf(row);
    entry.scheduleViewport = { offset: Math.max(0, Math.min(index - scheduleBuffer, entry.scheduleRows.length - scheduleWindowSize)), top: entry.scheduleRows.length > scheduleWindowSize ? Math.max(0, index - 2) * scheduleRowHeight : 0, left: entry.scheduleViewport?.left || 0 };
    scheduleChanged(entry); message(uiCopy("Line {0} added.", [row - schedule.first_row + 1])); await calculate();
  }

  async function removeScheduleRow(row, entry = current()) {
    if (!entry || entry !== current() || state.action || entry.invalid.size || !entry.scheduleRows?.includes(row)) return;
    const schedule = entry.definition.schedule, sheet = schedule.sheet, hadSheet = Object.prototype.hasOwnProperty.call(entry.inputs, sheet), values = entry.inputs[sheet] ||= {};
    const addresses = scheduleEditableAddresses(entry, row), before = addresses.map((address) => [address, Object.prototype.hasOwnProperty.call(values, address), values[address]]);
    (entry.removedRows ||= []).push({ row, rows: [...entry.scheduleRows], before, hadSheet, placeholder: entry.scheduleRows.length === 1 ? schedule.first_row : null });
    if (entry.removedRows.length > 20) entry.removedRows.shift();
    for (const address of addresses) values[address] = null;
    entry.scheduleRows = entry.scheduleRows.filter((value) => value !== row);
    if (!entry.scheduleRows.length) entry.scheduleRows = [schedule.first_row];
    const viewport = entry.scheduleViewport ||= {};
    viewport.offset = Math.max(0, Math.min(viewport.offset || 0, entry.scheduleRows.length - scheduleWindowSize));
    viewport.top = Math.max(0, Math.min(viewport.top || 0, (entry.scheduleRows.length - 1) * scheduleRowHeight));
    scheduleChanged(entry); message(uiCopy("Line {0} removed. Use Undo remove to restore it.", [row - schedule.first_row + 1])); await calculate();
  }

  function scheduleDeleteContext(entry) {
    return { entry, revision: entry.revision, loadRevision: state.loadRevision, sheet: entry.sheet,
      fingerprint: projectFingerprint(false), target: JSON.stringify(window.CeasefireProject?.downloadTarget?.()) };
  }

  function scheduleDeleteSources(entry, row) { return JSON.stringify(window.CeasefireTakeoffs?.scheduleBindings(entry.definition.id, row) || []); }

  function scheduleDeleteCurrent(row, entry, review) {
    return entry === current() && entry === review.entry && !state.action && !entry.invalid.size && entry.revision === review.revision
      && state.loadRevision === review.loadRevision && entry.sheet === review.sheet && entry.scheduleRows?.includes(row)
      && projectFingerprint(false) === review.fingerprint && scheduleDeleteSources(entry, row) === review.sources
      && JSON.stringify(window.CeasefireProject?.downloadTarget?.()) === review.target;
  }

  async function requestRemoveScheduleRow(row, entry = current(), renderedReview = null) {
    if (renderedReview && !scheduleDeleteCurrent(row, entry, renderedReview)) {
      message(uiCopy("The displayed item changed. Nothing was deleted. Wait for the current schedule and review the item again."), true); return;
    }
    document.activeElement?.blur?.();
    if (!entry || entry !== current() || state.action || entry.invalid.size || !entry.scheduleRows?.includes(row)) return;
    const review = renderedReview || { ...scheduleDeleteContext(entry), sources: scheduleDeleteSources(entry, row) };
    if (!scheduleDeleteCurrent(row, entry, review)) {
      message(uiCopy("The item changed while finishing its edit. Nothing was deleted. Wait for the current schedule and review the item again."), true); return;
    }
    const confirm = window.CeasefireDialogs?.confirm || confirmReplace;
    if (!await confirm("Delete item?", "Are you sure you want to delete this item?", "Yes", "Cancel")) return;
    if (!scheduleDeleteCurrent(row, entry, review)) {
      message(uiCopy("The item or project changed during deletion review. Nothing was deleted. Review the current item again."), true); return;
    }
    await removeScheduleRow(row, entry);
  }

  function scheduleDeleteButton(row, entry, context) {
    const item = row - entry.definition.schedule.first_row + 1;
    const remove = node("button", "button secondary calculator-remove-row"), icon = node("span", "calculator-trash-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
    remove.append(icon); window.CeasefireI18n.attr(remove, "title", "Delete line {0}", [item]);
    remove.type = "button"; remove.dataset.scheduleRemove = String(row); remove.disabled = state.action || entry.invalid.size > 0;
    const review = { ...context, sources: scheduleDeleteSources(entry, row) };
    window.CeasefireI18n.attr(remove, "aria-label", "Delete line {0}", [item]); remove.addEventListener("click", () => requestRemoveScheduleRow(row, entry, review));
    return remove;
  }

  function refreshScheduleDeleteControls(entry) {
    const controls = [...$("calculator-grid").querySelectorAll("[data-schedule-remove]")];
    if (!controls.length) return;
    const context = scheduleDeleteContext(entry);
    for (const control of controls) control.replaceWith(scheduleDeleteButton(Number(control.dataset.scheduleRemove), entry, context));
  }

  async function undoScheduleRemove(entry = current()) {
    if (!entry || entry !== current() || state.action || entry.invalid.size || !entry.removedRows?.length) return;
    const removed = entry.removedRows.pop(), values = entry.inputs[entry.definition.schedule.sheet] ||= {};
    for (const [address, existed, value] of removed.before) { if (existed) values[address] = value; else delete values[address]; }
    const retained = entry.scheduleRows.filter((row) => row !== removed.placeholder || scheduleEditableAddresses(entry, row).some((address) => values[address] !== null && values[address] !== undefined && values[address] !== ""));
    entry.scheduleRows = [...new Set([...retained, ...removed.rows])].sort((left, right) => left - right);
    if (!removed.hadSheet && !Object.keys(values).length) delete entry.inputs[entry.definition.schedule.sheet];
    const index = entry.scheduleRows.indexOf(removed.row);
    entry.scheduleViewport = { offset: Math.max(0, Math.min(index - scheduleBuffer, entry.scheduleRows.length - scheduleWindowSize)), top: entry.scheduleRows.length > scheduleWindowSize ? Math.max(0, index - 2) * scheduleRowHeight : 0, left: entry.scheduleViewport?.left || 0 };
    scheduleChanged(entry); message(uiCopy("Removed row restored with its original inputs.")); await calculate();
  }

  function renderScheduleTools(entry) {
    const toolbar = node("div", "calculator-schedule-tools"), add = node("button", "button primary icon-only"), undo = node("button", "button secondary icon-only");
    add.type = undo.type = "button"; add.dataset.scheduleAdd = "true"; undo.dataset.scheduleUndo = "true";
    const addIcon = node("span", "button-symbol", "+"), undoIcon = node("span", "button-symbol", "↶"); addIcon.setAttribute("aria-hidden", "true"); undoIcon.setAttribute("aria-hidden", "true");
    window.CeasefireI18n.attr(add, "title", "Add row"); window.CeasefireI18n.attr(add, "aria-label", "Add row"); add.append(addIcon);
    window.CeasefireI18n.attr(undo, "title", "Undo remove"); window.CeasefireI18n.attr(undo, "aria-label", "Undo remove"); undo.append(undoIcon);
    const capacity = entry.definition.schedule.last_row - entry.definition.schedule.first_row + 1;
    add.disabled = state.action || entry.invalid.size > 0 || entry.scheduleRows.length >= capacity;
    undo.disabled = state.action || entry.invalid.size > 0 || !entry.removedRows?.length;
    add.addEventListener("click", () => addScheduleRow(entry)); undo.addEventListener("click", () => undoScheduleRemove(entry));
    const count = uiNode("span", "helper", "{0} {1} · Capacity {2}", [entry.scheduleRows.length.toLocaleString("en-AU"), window.CeasefireI18n.term(entry.scheduleRows.length === 1 ? "row" : "rows"), capacity.toLocaleString("en-AU")]);
    const help = uiNode("span", "helper calculator-schedule-help", "Line numbers stay with their items. Removing a row clears its inputs; Undo remove restores them.");
    toolbar.append(add, undo, count, help); return toolbar;
  }

  function bindScheduleScroll(scroll, entry, view) {
    scroll.dataset.scheduleViewport = "true";
    const viewport = entry.scheduleViewport ||= { offset: view.offset, top: 0, left: 0 };
    scroll.scrollTop = viewport.top || 0; scroll.scrollLeft = viewport.left || 0;
    let timer;
    const onScroll = () => {
      if (entry !== current() || scheduleFor(entry)?.sheet !== entry.sheet) return;
      if (window.CeasefireScheduleColumns.isProjectionScroll(scroll)) return;
      scroll.scheduleColumnProjection = null;
      const previousTop = viewport.top || 0, previousLeft = viewport.left || 0;
      viewport.top = scroll.scrollTop; viewport.left = scroll.scrollLeft;
      clearTimeout(timer);
      if (entry.scheduleRows.length <= scheduleWindowSize) return;
      const first = Math.max(0, Math.floor(scroll.scrollTop / scheduleRowHeight));
      const shown = Math.ceil((scroll.clientHeight || 650) / scheduleRowHeight);
      if (first >= view.offset + 4 && first + shown <= view.offset + view.limit - 4 || view.offset === 0 && first < 4 || view.offset + view.limit >= entry.scheduleRows.length && first + shown >= entry.scheduleRows.length - 4) return;
      // Commit the focused editor before replacing a distant window. Input
      // events already retain its exact value; blur completes list validation.
      const focused = document.activeElement;
      if (focused?.dataset?.calculatorSheet === entry.sheet && (focused.dataset.calculatorCell || focused.dataset.calculatorCustomCell)) focused.blur?.();
      if (entry.invalid.size) {
        // A user may have scrolled within this window since entering the
        // invalid value. Reveal its actual editor, not just that later scroll
        // position. Prefer a visible custom editor to its accompanying select.
        const controls = [...scroll.querySelectorAll("[data-calculator-custom-cell]"), ...scroll.querySelectorAll("[data-calculator-cell]")];
        const invalid = controls.find((control) => !control.hidden && control.getClientRects?.().length &&
          (typeof getComputedStyle !== "function" || getComputedStyle(control).visibility !== "hidden") &&
          entry.invalid.has(`${control.dataset.calculatorSheet}!${control.dataset.calculatorCustomCell || control.dataset.calculatorCell}`));
        let top = previousTop, left = previousLeft;
        if (invalid) {
          const box = scroll.getBoundingClientRect(), rect = invalid.getBoundingClientRect();
          const headerHeight = scroll.querySelector?.("thead")?.getBoundingClientRect().height || 0;
          const y = scroll.scrollTop + rect.top - box.top - (scroll.clientTop || 0), x = scroll.scrollLeft + rect.left - box.left - (scroll.clientLeft || 0);
          if (rect.height > Math.max(0, scroll.clientHeight - headerHeight - 16)) top = Math.max(0, y - headerHeight - 8);
          else if (y < top + headerHeight + 8) top = Math.max(0, y - headerHeight - 8);
          else if (y + rect.height > top + scroll.clientHeight - 8) top = Math.max(0, y + rect.height - scroll.clientHeight + 8);
          if (rect.width > Math.max(0, scroll.clientWidth - 16)) left = Math.max(0, x - 8);
          else if (x < left + 8) left = Math.max(0, x - 8);
          else if (x + rect.width > left + scroll.clientWidth - 8) left = Math.max(0, x + rect.width - scroll.clientWidth + 8);
        }
        scroll.scrollTop = top; scroll.scrollLeft = left;
        viewport.top = scroll.scrollTop; viewport.left = scroll.scrollLeft;
        message(uiCopy("Correct the invalid input before scrolling to another group of rows."), true); return;
      }
      timer = setTimeout(() => {
        if (entry !== current() || !scheduleFor(entry) || entry.invalid.size) return;
        const offset = Math.max(0, Math.min(first - scheduleBuffer, entry.scheduleRows.length - scheduleWindowSize));
        if (offset === entry.scheduleViewport?.offset) return;
        entry.scheduleViewport.offset = offset; entry.needsRender = true; calculate({ viewport: true });
      }, 80);
    };
    scroll.addEventListener("scroll", onScroll);
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  // Bind UI copy explicitly; worksheet values and evidence remain verbatim.
  function uiNode(tag, className, source, args = []) {
    return window.CeasefireI18n.nodeText(node(tag, className), source, args);
  }
  function uiCopy(source, args = []) { return source === "" ? "" : { i18nSource: source, i18nArgs: args }; }
  function uiText(element, copy) {
    if (copy && typeof copy === "object" && Object.hasOwn(copy, "i18nSource")) return window.CeasefireI18n.text(element, copy.i18nSource, copy.i18nArgs);
    if (copy && typeof copy === "object") return window.CeasefireI18n.text(element, "{0}", [copy]);
    return window.CeasefireI18n.text(element, copy == null ? "" : String(copy));
  }

  function message(text = "", error = false) {
    const box = $("calculator-message");
    uiText(box, text); box.hidden = !text;
    box.className = `message${error ? " error" : ""}`;
    box.setAttribute("role", error ? "alert" : "status");
  }

  async function request(path, options = {}) {
    const endActivity = window.CeasefireActivity?.begin();
    try {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
    } finally { endActivity?.(); }
  }

  async function calculatorList() {
    if (state.list) return state.list;
    if (!state.listRequest) {
      const pending = request("/api/calculators").then(data => data.calculators);
      state.listRequest = pending;
      try { state.list = await pending; return state.list; }
      finally { if (state.listRequest === pending) state.listRequest = null; }
    }
    return state.listRequest;
  }

  async function calculatorDefinition(id) {
    if (state.entries.has(id)) return state.entries.get(id).definition;
    if (state.definitionRequests.has(id)) return state.definitionRequests.get(id);
    // Share only an in-flight read. Each caller still applies its own navigation
    // and project guards, and draft inputs are cloned when creating an entry.
    const pending = request(endpoint(id));
    state.definitionRequests.set(id, pending);
    try { return await pending; }
    finally { if (state.definitionRequests.get(id) === pending) state.definitionRequests.delete(id); }
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
    return editing ? String(visible) : (cell.control_exact ? controlExactNumber : controlNumber).format(visible);
  }

  function scheduleColumnWidth(column, label, lineColumn) {
    if (column === lineColumn) return 60;
    if (/notes?|status|requirements|basis|sources?/i.test(label)) return 224;
    if (/product|steel id|section|member mark|item.*mark|location|duct use/i.test(label)) return 170;
    if (/exposure|input method|orientation|frl/i.test(label)) return 156;
    return 112;
  }

  function sheetMetadata(entry) { return entry.definition.sheets.find((sheet) => sheet.name === entry.sheet) || {}; }
  function displayPages(definition, factorView = false) {
    const pages = definition.display_pages?.length ? definition.display_pages : definition.pages.map((sheet) => ({ id: sheet, label: sheet, sheet }));
    return pages.filter(page => !(["steel_vermiculite", "steel_board"].includes(definition.id) && page.id === "START")
      && !(definition.id === "steel_vermiculite" && (factorView ? page.id !== "FACTOR CALCS" : ["CALCULATOR", "FACTOR CALCS"].includes(page.id)))
      && !(definition.id === "steel_board" && page.sheet === "EXTRA BOARDS")).map((page) => page.id === "FACTOR CALCS" ? { ...page, label: "Factor Calcs", section_ids: page.section_ids.filter(id => id !== "A370") } : page.id === "CALCULATOR" && page.sheet === "CALCULATOR" ?
      { ...page, label: definition.id === "steel_vermiculite" ? "LOOKUP" : ["steel_board", "ductwork"].includes(definition.id) ? "SCHEDULE" : page.label }
      : definition.id === "steel_vermiculite" && page.id === "BAGS" ? { ...page, label: "SUMMARY" } : page);
  }
  function currentPage(entry) { return entry.page || entry.sheet; }
  function pageDefinition(entry) { return displayPages(entry.definition, entry.factorView).find((page) => page.id === currentPage(entry)) || { id: currentPage(entry), label: currentPage(entry), sheet: entry.sheet }; }
  function hiddenColumns(metadata) {
    const hidden = new Set(metadata.hidden_columns || []);
    for (const [column, width] of Object.entries(metadata.column_widths || {})) if (Number.isFinite(Number(width)) && Number(width) <= 0) hidden.add(columnNumber(column));
    return hidden;
  }

  function sourceDisplayText(value, entry, address, result = entry?.result) {
    if (!entry) return value;
    const browserText = browserPresentation[entry.definition.id]?.[entry.sheet]?.text;
    if (Object.prototype.hasOwnProperty.call(browserText || {}, address)) return browserText[address];
    const overrides = result?.display_text || sheetMetadata(entry).display_text || {};
    if (Object.prototype.hasOwnProperty.call(overrides, address) && typeof overrides[address] === "string") return overrides[address];
    if (typeof value !== "string") return value;
    const id = entry.definition.id;
    let replacements = sourceDirections[id]?.[entry.sheet]?.[address] || [];
    if (id === "steel_vermiculite") replacements = [...replacements, ["CALCULATOR", "SCHEDULE"], ["BAGS", "SUMMARY"]];
    const position = parseAddress(address);
    const schedule = entry.definition.schedule;
    if (id === "steel_board" && position && ((entry.sheet === schedule?.sheet && position.column === 35 && position.row >= schedule.first_row && position.row <= schedule.last_row) || (entry.sheet === "SETTINGS" && position.column === 17 && position.row >= 6 && position.row <= 51))) replacements = boardStatusDirections;
    return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
  }
  function documentLabels(entry = current()) {
    const schedule = entry?.definition.id === "ductwork" ? "Duct Schedule" : "Steel Schedule";
    return { "calculator-import": "Import Schedule", "calculator-excel": `${schedule} XLSX`,
      "calculator-pdf": `${schedule} PDF`, "calculator-summary-pdf": "Product Summary PDF", "calculator-template": "Export Template" };
  }
  function renderDocumentLabels(entry = current()) {
    for (const [id, label] of Object.entries(documentLabels(entry))) {
      const button = $(id);
      window.CeasefireI18n.attr(button, "title", label);
      if (button.getAttribute("aria-busy") !== "true") window.CeasefireI18n.attr(button, "aria-label", label);
      const text = button.lastElementChild;
      if (text) window.CeasefireI18n.text(text, label);
    }
  }
  function updateStatus(entry = current()) {
    window.CeasefireTakeoffs?.calculatorDraftChanged?.();
    window.CeasefireProject?.changed?.();
    if (!entry || entry !== current()) return;
    renderDocumentLabels(entry);
    window.CeasefireI18n.text($("calculator-save-status"), entry.invalid.size ? "Check input" : dirty(entry) ? "Unsaved changes" : "Saved");
    const hasErrors = entry.invalid.size > 0;
    $("calculator-recalculate").disabled = state.calculating || hasErrors;
    $("calculator-recalculate").setAttribute("aria-busy", String(state.calculating));
    $("calculator-pdf").disabled = state.action || hasErrors;
    $("calculator-excel").disabled = state.action || hasErrors;
    $("calculator-summary-pdf").disabled = state.action || hasErrors;
    if (hasErrors) calculationStatus(uiCopy("Enter a valid number to recalculate."));
    $("calculator-reset").disabled = state.action;
    $("calculator-import").disabled = state.action;
    $("calculator-template").disabled = state.action;
    for (const button of $("calculator-grid").querySelectorAll("[data-schedule-add]")) button.disabled = state.action || hasErrors || entry.scheduleRows.length >= entry.definition.schedule.last_row - entry.definition.schedule.first_row + 1;
    for (const button of $("calculator-grid").querySelectorAll("[data-schedule-undo]")) button.disabled = state.action || hasErrors || !entry.removedRows?.length;
    for (const button of $("calculator-grid").querySelectorAll("[data-schedule-remove]")) button.disabled = state.action || hasErrors;
  }

  function calculationStatus(text = "") {
    const status = $("calculator-calculation-status"); uiText(status, text); status.hidden = !text;
  }

  function setInput(entry, sheet, address, value) {
    if (state.takeoffReservation) { message(uiCopy("Wait for the takeoff transfer to finish before editing the schedule.")); return; }
    entry.inputs[sheet] ||= {};
    const schedule = entry.definition.schedule, position = parseAddress(address);
    if (sheet === schedule?.sheet && schedule.quantity_column && position
        && position.row >= schedule.first_row && position.row <= schedule.last_row
        && ![schedule.quantity_column, schedule.location_column, schedule.line_id_column].includes(columnName(position.column))
        && !(entry.definition.id === "steel_board" && position.column === 1)) {
      // Loading an older member keeps its omitted Quantity as one. A new
      // material edit requires an explicit choice; descriptive edits do not.
      const quantityAddress = `${schedule.quantity_column}${position.row}`;
      if (!Object.prototype.hasOwnProperty.call(entry.inputs[sheet], quantityAddress)) entry.inputs[sheet][quantityAddress] = null;
    }
    entry.inputs[sheet][address] = value;
    // Reusing a removed source row is a new draft. Undo must never overwrite
    // fresh edits entered into the one-row placeholder (or a stale DOM row).
    if (sheet === entry.definition.schedule?.sheet && entry.removedRows?.length) entry.removedRows = entry.removedRows.filter((removed) => removed.row !== parseAddress(address)?.row);
    entry.pendingResult = null;
    entry.navigationCache = null;
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

  function effectiveControlValue(entry, sheet, address, fallback) {
    const value = Object.prototype.hasOwnProperty.call(entry.inputs[sheet] || {}, address) ? entry.inputs[sheet][address] : fallback;
    // The new SC902 pack-volume input derives its blank value from the saved
    // component masses and density. Displaying it never rewrites those inputs.
    if (entry.definition.id === "steel_intumescent" && sheet === "SETTINGS" && address === "D24"
        && (value === undefined || value === null || value === "")) return fallback;
    const defaults = entry.definition.automatic_defaults?.[sheet];
    return (value === undefined || value === null || value === "") && defaults && Object.prototype.hasOwnProperty.call(defaults, address) ? defaults[address] : value;
  }

  function applyRequiredState(control, cell) {
    control.required = Boolean(cell.required_active);
    control.setAttribute("aria-required", String(Boolean(cell.required)));
    control.classList.toggle("calculator-required-missing", Boolean(cell.required_missing));
  }

  function makeControl(cell, row, entry, label, item = null) {
    const address = cell.address || `${columnName(cell.column)}${row}`;
    const key = `${entry.sheet}!${address}`;
    const sourceSheet = entry.sheet;
    const rawValue = () => {
      const latest = entry.latestCells?.get(key);
      return effectiveControlValue(entry, sourceSheet, address, latest ? latest.value : cell.value);
    };
    const value = rawValue();
    const options = cellOptions(cell, entry);
    const schedule = scheduleFor(entry), coordinates = parseAddress(address);
    const listedDuctChoice = cell.type === "select" && entry.definition.id === "ductwork" && entry.sheet === "CALCULATOR"
      && schedule && coordinates && coordinates.row >= schedule.first_row && coordinates.row <= schedule.last_row
      && [3, 5, 8, 9].includes(coordinates.column);
    const closedDuctSetting = cell.type === "select" && entry.definition.id === "ductwork" && entry.sheet === "PRODUCT SETTINGS"
      && ["B35", "B65", "B73"].includes(address);
    const closedMonokoteSetting = cell.type === "select" && entry.definition.id === "steel_vermiculite" && entry.sheet === "SETTINGS"
      && ["D569", "D570"].includes(address);
    const closedSetting = closedDuctSetting || closedMonokoteSetting;
    const searchableSteel = cell.type === "select" && options.some(option => typeof option === "string") && schedule && coordinates && entry.sheet === schedule.sheet
      && coordinates.row >= schedule.first_row && coordinates.row <= schedule.last_row
      && (["steel_vermiculite", "steel_intumescent"].includes(entry.definition.id) && coordinates.column === 6 || entry.definition.id === "steel_board" && coordinates.column === 4);
    const listedIntumescentChoice = cell.type === "select" && entry.definition.id === "steel_intumescent"
      && entry.sheet === schedule?.sheet && coordinates?.row >= schedule.first_row
      && coordinates.row <= schedule.last_row && [3, 4].includes(coordinates.column);
    const listedChoice = listedDuctChoice || closedSetting || listedIntumescentChoice || Boolean(cell.strict_options);
    const allowOther = !listedChoice && (cell.allow_other || ["warning", "information"].includes(cell.error_style || cell.validation?.error_style || cell.validation?.errorStyle));
    // A dropdown may mix numbers and text (60 and "60/60/60"). Its current
    // selection cannot determine the type of every other available option.
    // These board design inputs remain numeric when their custom selectors are blank.
    const boardDesignNumber = entry.definition.id === "steel_board" && entry.sheet === schedule?.sheet
      && coordinates?.row >= schedule.first_row && coordinates.row <= schedule.last_row && [8, 10].includes(coordinates.column);
    const numeric = boardDesignNumber || cell.type === "number" || (cell.type === "select" && options.length > 0 && options.every(isNumber)) || (cell.type !== "select" && isNumber(value) && cell.type !== "text");
    const numericOptions = options.some(isNumber);
    const display = (entry.result?.display_cells || sheetMetadata(entry).display_cells || {})[address];
    const select = !searchableSteel && cell.type === "select" && (listedChoice || display?.control === "select" || !allowOther && options.length <= 40);
    const customAllowed = select && allowOther;
    const multiline = Boolean(cell.multiline);
    const control = node(select ? "select" : multiline ? "textarea" : "input", numeric ? "calculator-number" : "");
    const custom = customAllowed ? node("input", numeric ? "calculator-number" : "") : null;
    let customMode = false, customToken = "__calculator_custom_value__", customOption;
    while (options.some((option) => String(option) === customToken) || String(value) === customToken) customToken += "_";
    const displayedLabel = browserPresentation[entry.definition.id]?.[sourceSheet]?.control_labels?.[address] || label;
    const controlLabel = item ? window.CeasefireI18n.term("{0}, item {1}", [window.CeasefireI18n.term(displayedLabel), item]) : window.CeasefireI18n.term(displayedLabel);
    if (custom) {
      custom.type = "text"; custom.hidden = true; custom.autocomplete = "off";
      custom.dataset.calculatorCustomCell = address; custom.dataset.calculatorSheet = sourceSheet;
      window.CeasefireI18n.attr(custom, "aria-label", "{0} custom value{1}", [controlLabel, window.CeasefireI18n.term(percent(cell) ? " in percent" : "")]);
      if (numeric) custom.inputMode = "decimal";
      customOption = uiNode("option", "", "Enter custom value…"); customOption.value = customToken;
    }
    const selectOptions = [];
    control.dataset.calculatorCell = address;
    control.dataset.calculatorSheet = entry.sheet;
    applyRequiredState(control, cell);
    if (custom) applyRequiredState(custom, cell);
    window.CeasefireI18n.attr(control, "aria-label", "{0}{1}", [controlLabel, window.CeasefireI18n.term(percent(cell) ? " in percent" : "")]);
    if (select) {
      const appendOption = (item) => {
        // Historical inputs stay visible and exact, without becoming new choices.
        const unavailable = listedChoice && item !== "" && !options.some((choice) => String(choice) === String(item));
        const option = node("option"); option.value = String(item);
        if (unavailable) window.CeasefireI18n.text(option, "Saved value: {0} (choose a listed value)", [item]);
        else if (item === "") window.CeasefireI18n.text(option, "(blank)");
        else if (calculatorChoiceLabel(entry, address, item, options.some((choice) => String(choice) === String(item)))) window.CeasefireI18n.text(option, item);
        else option.textContent = displayValue(item, cell);
        if (unavailable) option.disabled = true;
        control.append(option); selectOptions.push({ option, value: item, unavailable });
        if (isNumber(item)) window.CeasefireI18n.attr(option, "title", "Exact value: {0}{1}", [numericInputValue(item, cell, true), window.CeasefireI18n.term(percent(cell) ? "%" : "")]);
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
      if (!closedSetting || value == null || value === "") appendOption("");
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
    if (isNumber(value)) window.CeasefireI18n.attr(control, "title", "Exact value: {0}{1}", [numericInputValue(value, cell, true), window.CeasefireI18n.term(percent(cell) ? "%" : "")]);
    if (entry.invalid.has(key)) { control.value = entry.invalid.get(key); control.setAttribute("aria-invalid", "true"); }
    const bindEditor = (editor, isChoice) => {
      let focusedValue;
      editor.addEventListener("focus", () => {
        for (const item of selectOptions) if (isNumber(item.value) && !item.unavailable) item.option.textContent = `${numericInputValue(item.value, cell, true)}${percent(cell) ? "%" : ""}`;
        if (!isChoice && !entry.invalid.has(key)) {
          const raw = rawValue();
          if (numeric || isNumber(raw)) { editor.value = numericInputValue(raw, cell, true); editor.select(); }
        }
        focusedValue = editor.value;
      });
      editor.addEventListener(isChoice || searchableSteel ? "change" : "input", () => {
        if (isChoice && custom && editor.value === customToken) {
          customMode = true; custom.hidden = false;
          custom.value = entry.invalid.has(key) ? entry.invalid.get(key) : numericInputValue(rawValue(), cell, true);
          custom.focus?.(); return;
        }
        if (isChoice && custom) { customMode = false; custom.hidden = true; }
        let next = editor.value;
        const optionText = (option) => String(!isChoice && isNumber(option) && percent(cell) ? decimalShift(option, 2) : option);
        const optionIndex = options.findIndex((option) => optionText(option) === next);
        if ((listedChoice || searchableSteel && !allowOther && next !== String(rawValue() ?? "")) && next !== "" && optionIndex < 0) {
          editor.value = String(rawValue() ?? "");
          calculationStatus(uiCopy("Choose a value from the available list.")); return;
        }
        const selectedOption = isChoice ? selectOptions.find(({ option }) => option.value === next) : null;
        const validSyntax = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(next.trim());
        if (selectedOption) next = selectedOption.value;
        else if (optionIndex >= 0) next = options[optionIndex];
        else if ((numeric || (numericOptions && validSyntax)) && next !== "") {
          next = validSyntax ? Number(next) : NaN;
          if (!Number.isFinite(next)) {
            entry.invalid.set(key, editor.value); editor.setAttribute("aria-invalid", "true"); control.setAttribute("aria-invalid", "true");
            entry.revision++; entry.pendingResult = null; entry.navigationCache = null; clearTimeout(state.timer); updateStatus(entry);
            calculationStatus(uiCopy("Enter a valid number to recalculate.")); return;
          }
          if (percent(cell)) next = decimalShift(next, -2);
        }
        if (cell.quantity && next !== "" && (typeof next !== "number" || !Number.isFinite(next) || next <= 0 || !Number.isInteger(next))) {
          entry.invalid.set(key, editor.value); editor.setAttribute("aria-invalid", "true");
          entry.revision++; entry.pendingResult = null; entry.navigationCache = null; clearTimeout(state.timer); updateStatus(entry);
          calculationStatus(uiCopy("Quantity: enter a positive whole number.")); return;
        }
        entry.invalid.delete(key); control.removeAttribute("aria-invalid"); custom?.removeAttribute("aria-invalid");
        if (isNumber(next)) window.CeasefireI18n.attr(editor, "title", "Exact value: {0}{1}", [numericInputValue(next, cell, true), window.CeasefireI18n.term(percent(cell) ? "%" : "")]);
        else editor.removeAttribute("title");
        setInput(entry, sourceSheet, address, next);
      });
      editor.addEventListener("blur", (event) => {
        const selectedValue = Object.prototype.hasOwnProperty.call(entry.inputs[sourceSheet] || {}, address) ? entry.inputs[sourceSheet][address] : value;
        if (!isChoice && cell.type === "select" && !allowOther && selectedValue !== null && selectedValue !== "" && !options.some((option) => String(option) === String(selectedValue)) && String(value ?? "") !== String(selectedValue)) {
          entry.invalid.set(key, editor.value); editor.setAttribute("aria-invalid", "true");
          calculationStatus(uiCopy("Choose a value from the available list.")); updateStatus(entry);
        }
        for (const item of selectOptions) if (isNumber(item.value) && !item.unavailable) item.option.textContent = displayValue(item.value, cell);
        if (isChoice && listedDuctChoice && !entry.invalid.has(key)) {
          const latest = rawValue();
          control.calculatorEnsureOption(latest); editor.value = String(latest ?? "");
        }
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
    if (searchableSteel && window.CeasefireSearchableChoice) return window.CeasefireSearchableChoice(control, options);
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

  function bindCalculatorLabel(element, cell, entry, address, display = cell.value) {
    if (!cell.editable && !cell.calculated && typeof cell.value === "string"
      && calculatorLabelSources[entry?.definition.id]?.[entry?.sheet]?.[address] === cell.value) {
      window.CeasefireI18n.text(element, display); return true;
    }
    return false;
  }

  const calculatorChoiceTerms = new Set("Internal|External|Both|Stair pressurisation|Other pressurisation|Horizontal|Vertical|Beam|Column|Channel|Angle|Tee|Standard|Rotate|Partial depth|Opposite B|Opposite D|Custom girth|Auto|Single|Double|Published first|General only|Standard box|XS top of wall|Promat trapezoid unfilled|Special / engineered|Section|Lower web (mm)|Exact only|Next higher (estimate)|Re-entrant - 3 sides|Re-entrant - 4 sides|Hollow - 3 sides|Hollow - 4 sides|Castellated - special factor|PFC web to slab - 3 sides|Not confirmed|Confirmed by project designer|Un-injected|Uninjected|Injected|Calibrated|Uncalibrated".split("|"));
  function calculatorChoiceLabel(entry, address, item, listed) {
    if (!listed || !calculatorChoiceTerms.has(item)) return false;
    const position = parseAddress(address), schedule = entry.definition.schedule;
    if (schedule?.sheet === entry.sheet && position?.row >= schedule.first_row && position.row <= schedule.last_row) {
      const columns = { steel_vermiculite: [3, 5], steel_intumescent: [3, 5], steel_board: [9, 11, 13, 15, 16, 17], ductwork: [8, 9] };
      return (columns[entry.definition.id] || []).includes(position.column);
    }
    return entry.definition.id === "steel_vermiculite" && (entry.sheet === "CALCULATOR" && ["D7", "D9"].includes(address)
      || entry.sheet === "SETTINGS" && ["D12", "D14", "D358", "D569", "D570"].includes(address))
      || entry.definition.id === "ductwork" && entry.sheet === "PRODUCT SETTINGS" && ["B35", "B65", "B73"].includes(address);
  }

  let basisDialogBinding = null;
  function scheduleBasis(entry, address, value) {
    const position = parseAddress(address), schedule = entry?.definition.schedule;
    if (entry.sheet !== schedule?.sheet || !position
        || position.row < schedule.first_row || position.row > schedule.last_row) return null;
    const compactOutput = entry.definition.id === "steel_board" && position.column === 35
      || entry.definition.id === "ductwork" && position.column === 39;
    const steelBasis = ["steel_vermiculite", "steel_intumescent"].includes(entry.definition.id) && position.column === 25;
    if (!compactOutput && !steelBasis) return null;
    const cells = entry.result?.rows?.find(row => row.row === position.row)?.cells || [];
    const missing = [...new Set(cells.filter(cell => cell.required_missing).map(cell => window.CeasefireI18n.term(cell.label)))];
    const review = missing.length ? window.CeasefireI18n.translate("Review required: {0}", [missing.join(", ")]) : "";
    value = typeof value === "string" ? value : "";
    if (!value.trim() && !review) return null;
    if (compactOutput) {
      const sentence = (review || value.split(/\r?\n/)[0].split(/[.!?]\s/)[0]).replace(/\s+/g, " ").trim();
      const preview = sentence.length > 96 ? sentence.slice(0, 93).trimEnd() + "…" : sentence;
      return { preview, full: [review, value].filter(Boolean).join("\n\n"), line: position.row - schedule.first_row + 1, address };
    }
    const at = column => cells.find(cell => cell.column === column)?.value;
    const thickness = at(15), status = at(22), quantity = at(23), source = at(24);
    const firstSentence = value.split(/\r?\n/)[0].split(/[.!?]\s/)[0];
    const thicknessText = isNumber(thickness) ? `${thickness} ${entry.definition.id === "steel_intumescent" ? "µm" : "mm"}` : "";
    const sourceText = typeof source === "string" ? source.split(";")[0].replace(/ Table /g, " T") : "";
    const unavailable = typeof status === "string" && !/^(PUBLISHED|ESTIMATE)/.test(status) ? status : "";
    const estimate = typeof status === "string" && status.startsWith("ESTIMATE") ? window.CeasefireI18n.translate("Estimate") : "";
    const quantityIssue = typeof quantity === "string" && quantity && !quantity.startsWith("QUANTIFIED") ? quantity : "";
    const parts = [unavailable || thicknessText, sourceText, estimate, quantityIssue].filter(Boolean);
    const preview = (review || (parts.length ? parts.join(" · ") : firstSentence)).replace(/\s+/g, " ").trim();
    const full = [[window.CeasefireI18n.translate("Thickness status"), status], [window.CeasefireI18n.translate("Quantity status"), quantity], [window.CeasefireI18n.translate("Source"), source]]
      .filter(([, text]) => text !== null && text !== undefined && text !== "")
      .map(([label, text]) => `${label}: ${text}`).join("\n");
    return { preview, full: [review, full, value].filter(Boolean).join("\n\n"),
      line: position.row - schedule.first_row + 1, address };
  }

  function showBasisDetails(entry, basis, trigger) {
    const dialog = $("calculator-basis-dialog");
    uiText($("calculator-basis-context"), uiCopy("Line {0}", [basis.line]));
    $("calculator-basis-full").textContent = basis.full;
    basisDialogBinding = { id: entry.definition.id, sheet: entry.sheet, address: basis.address, trigger };
    if (!dialog.open) dialog.showModal();
  }

  $("calculator-basis-dialog").addEventListener("close", () => {
    const binding = basisDialogBinding; basisDialogBinding = null;
    binding?.trigger.focus?.();
  });

  function updateOutputCell(element, cell) {
    const address = cell.address || element.dataset.calculatorOutput, entry = current();
    const value = sourceDisplayText(cell.value, entry, address), suffix = entry && (entry.result?.display_cells || sheetMetadata(entry).display_cells)?.[address]?.suffix;
    const schedule = entry?.definition.schedule, position = parseAddress(address);
    const basis = scheduleBasis(entry, address, value);
    const lineNumber = schedule && entry.sheet === schedule.sheet && position?.column === columnNumber(schedule.line_id_column) && position.row >= schedule.first_row && position.row <= schedule.last_row;
    element.textContent = (lineNumber && Number.isInteger(value) ? String(value) : displayValue(value, cell)) + (isNumber(value) && !cell.error && typeof suffix === "string" ? suffix : "");
    if (cell.calculated && browserPresentation[entry?.definition.id]?.[entry?.sheet]?.split_status?.includes(address)) {
      // Keep the status in its original merged output cell. The invisible
      // internal divider follows the label/value columns below (H:J / K:N).
      const columns = node("span", "calculator-status-columns"), status = node("span", "calculator-status-text", element.textContent), empty = node("span");
      empty.setAttribute("aria-hidden", "true"); columns.append(status, empty);
      element.classList.add("calculator-split-status"); element.replaceChildren(columns);
    }
    if (entry?.definition.id === "steel_vermiculite" && entry.sheet === "SETTINGS" && ["J32", "J65", "J97", "J174", "J230"].includes(address) && cell.value === "BACK TO TOP") {
      const link = uiNode("a", "calculator-inline-link", "Back to worksheet controls"); link.href = "#calculator-sheet-title"; element.replaceChildren(link);
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
    const translatedLabel = bindCalculatorLabel(element, cell, entry, address, value);
    if (basis) {
      const button = node("button", "calculator-basis-preview", basis.preview + " · " + window.CeasefireI18n.translate("Details"));
      button.type = "button";
      button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", "calculator-basis-dialog");
      button.setAttribute("aria-label", `${window.CeasefireI18n.translate("Basis / review note")} · ${window.CeasefireI18n.translate("Line {0}", [basis.line])}: ${basis.preview}`);
      button.addEventListener("click", () => showBasisDetails(entry, basis, button));
      element.replaceChildren(button); element.classList.add("calculator-compact-basis");
      if ($("calculator-basis-dialog").open && basisDialogBinding?.id === entry.definition.id
          && basisDialogBinding.sheet === entry.sheet && basisDialogBinding.address === address) {
        $("calculator-basis-full").textContent = basis.full;
        basisDialogBinding.trigger = button;
      }
    } else element.classList.toggle("calculator-compact-basis", false);
    if (element.dataset.calculatorVirtualOutput === "true" && !basis) {
      const content = node("div", "calculator-virtual-output", element.textContent); element.replaceChildren(content);
      if (translatedLabel) bindCalculatorLabel(content, cell, entry, address, value);
    }
  }

  function outputState(element, value) {
    const present = value !== null && value !== undefined && value !== "";
    element.classList.toggle("calculator-value-present", present);
    element.classList.toggle("calculator-value-empty", !present);
  }

  function displayMetadata(entry, result = entry.result) {
    const metadata = sheetMetadata(entry);
    const omittedRanges = [...(result?.omitted_ranges || metadata.omitted_ranges || []), ...(browserPresentation[entry.definition.id]?.[entry.sheet]?.omit || [])];
    const browser = browserPresentation[entry.definition.id]?.[entry.sheet] || {};
    const omittedColumns = [...(result?.omitted_columns || metadata.omitted_columns || []), ...(browser.omit_columns || []).map(columnNumber)];
    const columnOrder = [...(browser.column_order || []), ...(result?.display_column_order || metadata.display_column_order || [])];
    const spraySummary = entry.definition.id === "steel_vermiculite" && entry.sheet === "BAGS";
    if (spraySummary) omittedRanges.push("A17:I25");
    let settingsSections = result?.settings_sections ?? metadata.settings_sections ?? [];
    if (entry.definition.id === "steel_vermiculite" && entry.sheet === "SETTINGS") {
      const common = settingsSections.find(section => section.id === "A17");
      settingsSections = settingsSections.filter(section => section.id !== "A17").map(section => section.id === "A9" && common ? { ...section, ranges: [...section.ranges, ...common.ranges] } : section.id === "A356" ? { ...section, label: "HOLLOW SECTIONS" } : section);
    }
    const ductSettings = entry.definition.id === "ductwork" && entry.sheet === "PRODUCT SETTINGS";
    const ductSummary = entry.definition.id === "ductwork" && entry.sheet === "SUMMARY";
    if (ductSettings) {
      const application = settingsSections.find(section => section.id === "J94");
      settingsSections = settingsSections.filter(section => !["J94", "J115"].includes(section.id))
        .map(section => section.id === "A94" && application ? { ...section,
          ranges: [...section.ranges, ...application.ranges],
          display_columns: [...new Set([...(section.display_columns?.length ? section.display_columns : [1, 2, 3, 4, 5, 6, 7, 8]), ...(application.display_columns?.length ? application.display_columns : [10, 13, 14, 15])])],
        } : section);
    }
    // These are browser display copies; retained API metadata and source notes stay intact.
    settingsSections = settingsSections.map(section => browser.omit_section_notes?.includes(section.id) ? { ...section, note: "" } : section);
    const presentationTables = (result?.presentation_tables || metadata.presentation_tables || [])
      .filter(table => !spraySummary || table.title_address !== "A17")
      .filter(table => !ductSummary || table.first_row === 8)
      .filter(table => !ductSettings || table.title_address !== "J115")
      .map(table => browser.omit_table_notes?.includes(table.title_address) ? { ...table, note: "" } : table);
    return { ...metadata, omitted_rows: result?.omitted_rows || metadata.omitted_rows || [], omitted_columns: omittedColumns, omitted_ranges: omittedRanges, hidden_addresses: browserPresentation[entry.definition.id]?.[entry.sheet]?.hide || [], presentation_tables: presentationTables, table_layout: result?.table_layout || metadata.table_layout, display_column_order: columnOrder, display_text: result?.display_text || metadata.display_text || {}, display_cells: result?.display_cells || metadata.display_cells || {}, navigation_mode: result?.navigation_mode ?? metadata.navigation_mode ?? "links", settings_sections: settingsSections, display_table_order: result?.display_table_order ?? metadata.display_table_order ?? [], schedule_heading: result?.schedule_heading ?? metadata.schedule_heading ?? "", expand_tables: result?.expand_tables ?? metadata.expand_tables ?? false };
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
      if (cell) applyRequiredState(control, cell);
      if (!cell || control === document.activeElement || entry.invalid.has(key)) continue;
      const value = effectiveControlValue(entry, entry.sheet, address, cell.value);
      if (control.calculatorSyncValue) control.calculatorSyncValue(value);
      else {
        control.calculatorEnsureOption?.(value);
        const shown = String(control.tagName.toLowerCase() === "select" ? value ?? "" : isNumber(value) ? numericInputValue(value, cell) : value ?? "");
        if (String(control.value) !== shown) control.value = shown;
      }
      if (isNumber(value)) window.CeasefireI18n.attr(control, "title", "Exact value: {0}{1}", [numericInputValue(value, cell, true), window.CeasefireI18n.term(percent(cell) ? "%" : "")]);
    }
    renderProductTotals(result, entry.productTotalsElement);
    const reportRows = new Map(result.rows.map(row => [row.row, row]));
    for (const element of $("calculator-grid").querySelectorAll("[data-calculator-reports]")) renderReportReferences(element, reportRows.get(Number(element.dataset.calculatorReports))?.report_references || []);
    refreshBoardSteelAreas(result);
  }

  function renderReportReferences(element, references) {
    const renderer = window.CeasefireRegisterReferences?.renderReports;
    element.replaceChildren(...(references.length ? [renderer ? renderer(references) : node("span", "", references.map(reference => reference.label).join(" | "))] : []));
  }

  function boardSteelValue(result, row) {
    const area = result.board_net_steel_areas?.rows?.find(area => area.row === row);
    return !area ? "Recalculate to show steel area." : area.issues?.length ? `Unavailable (${area.issues.length} ${area.issues.length === 1 ? "line" : "lines"})` : area.net_steel_sqm;
  }

  function refreshBoardSteelAreas(result) {
    for (const cell of $("calculator-grid").querySelectorAll("[data-board-steel-row]")) {
      updateOutputCell(cell, { value: boardSteelValue(result, Number(cell.dataset.boardSteelRow)) });
    }
    const notes = current()?.boardSteelNotesElement;
    if (notes) {
      const areas = result.board_net_steel_areas;
      notes.replaceChildren(...(areas ? [areas.basis, ...(areas.notes || [])] : []).map(text => node("p", "helper", text)));
    }
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
    titles.push(result.rows.some(row => Object.prototype.hasOwnProperty.call(row, "report_references")));
    return JSON.stringify([{ ...pageDefinition(entry), section_spacing: result.section_spacing ?? metadata.section_spacing }, result.register_columns, result.visible_columns, metadata.omitted_rows, metadata.omitted_columns, metadata.omitted_ranges, metadata.hidden_addresses, metadata.presentation_tables, metadata.table_layout, metadata.display_column_order, metadata.display_text, metadata.display_cells, metadata.navigation_mode, metadata.settings_sections, metadata.display_table_order, metadata.schedule_heading, metadata.expand_tables, titles, content, result.option_sets || {}, rows.map((row) => row.cells.filter((cell) => cell.editable && !omittedColumns.has(cell.column) && !isOmitted(row.row, cell.column)).map((cell) => [cell.address || `${columnName(cell.column)}${row.row}`, cell.type, cell.options_ref || cell.options, cell.allow_other, cell.error_style, cell.validation]))]);
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
    if (entry.definition.id === "steel_board") box.classList.add("calculator-overview-board");
    const productSummary = entry.definition.id === "steel_vermiculite" && entry.sheet === "SCHEDULE";
    const boardSchedule = entry.definition.id === "steel_board" && entry.sheet === "CALCULATOR";
    if (productSummary) { used.add("M4"); used.add("M5"); }
    if (pairs.length === 3) cards.classList.add("calculator-summary-three");
    if (boardSchedule) for (const address of ["A4", "C4", "E4", "G4", "I4", "K4", "Y4", "AA4", "AC4", "AE4", "AG4", "AI4"]) used.add(address);
    for (const [labelAddress, valueAddress] of pairs) {
      const label = mapped.get(labelAddress), value = mapped.get(valueAddress);
      if (!label || !value || !columns.includes(value.column)) continue;
      const card = node("div", "calculator-summary-metric"), heading = node("span", "", sourceDisplayText(label.value, entry, labelAddress)), output = node("strong");
      bindCalculatorLabel(heading, label, entry, labelAddress, sourceDisplayText(label.value, entry, labelAddress));
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

  function renderProductTotals(result, container, overview = null) {
    if (!container) return;
    if (Array.isArray(result?.intumescent_product_totals)) {
      const columns = [["product", "Product"], ["area", "Coating area (m²)"], ["kg", "Required (kg)", "Required mixed (kg)"],
        ["litres", "Required (L)", "Required mixed (L)"], ["net", "Net packs"], ["waste", "Waste (%)"], ["whole", "Whole packs"],
        ["order_litres", "Order (L)", "Order volume (L)"], ["part_a", "Part A (kg)", "Part A to order (kg)"], ["part_b", "Part B (kg)", "Part B to order (kg)"],
        ["pack_kg", "Pack mass (kg)"], ["kit_litres", "Pack volume (L)", "Mixed pack volume (L)"], ["dry_litres", "Dry volume (L)", "Dry coating volume (L)"],
        ["pending", "Unresolved", "Unresolved items"], ["status", "Status", "Order status"]];
      const scroll = node("div", "calculator-product-totals-scroll"), table = node("table", "calculator-centered-data-table calculator-intumescent-totals"), head = node("thead"), header = node("tr"), body = node("tbody");
      scroll.setAttribute("role", "region"); scroll.tabIndex = 0;
      window.CeasefireI18n.attr(scroll, "aria-label", "Intumescent product summary · scroll horizontally for all columns");
      window.CeasefireI18n.attr(table, "aria-label", "Intumescent product summary");
      for (const [, label, fullLabel = label] of columns) {
        const cell = uiNode("th", "", label); cell.scope = "col";
        window.CeasefireI18n.attr(cell, "title", fullLabel);
        window.CeasefireI18n.attr(cell, "aria-label", fullLabel); header.append(cell);
      }
      head.append(header);
      for (const total of result.intumescent_product_totals) {
        const row = node("tr");
        for (const [key] of columns) {
          const cell = node(key === "product" ? "th" : "td", key === "status" ? "calculator-product-order-status" : "");
          if (key === "product") cell.scope = "row";
          cell.dataset.calculatorValue = "true";
          updateOutputCell(cell, {value: total[key], number_format: key === "waste" ? "0.00%" : "0.00"}); row.append(cell);
        }
        body.append(row);
      }
      table.append(head, body); scroll.append(table);
      const note = uiNode("p", "helper", "Whole packs are rounded once per product after waste. Review unresolved items before ordering. Mesh, primers and topcoats are separate allowances.");
      container.hidden = false; container.replaceChildren(scroll, note); return;
    }
    overview ||= [...(container.children || [])].find((child) => child.classList?.contains("calculator-overview")) || null;
    const board = Array.isArray(result?.board_product_totals);
    const totals = (board ? result.board_product_totals : result?.product_totals) || [];
    container.hidden = !totals.length;
    if (!totals.length) { container.replaceChildren(); return; }
    const heading = uiNode("h4", "", board ? "CALCULATED SUMMARY" : "PRODUCT SUMMARY"), note = board ? uiNode("p", "", "Box reference area measures the enclosure used for the board takeoff. Net board area and whole sheets include valid additional boards. Review products with incomplete rows.") : null;
    const scroll = node("div", "calculator-product-totals-scroll"), table = node("table", "calculator-centered-data-table"), head = node("thead"), body = node("tbody"), headers = node("tr");
    for (const label of board ? ["Product", "Box reference area (m²)", "Net board area (m²)", "Whole sheets", "Order status"] : ["Product", "Net bags", "Whole bags", "Order status"]) { const cell = uiNode("th", "", label); cell.scope = "col"; headers.append(cell); }
    head.append(headers);
    for (const total of totals) {
      const row = node("tr"), product = node("th", "", total.product); product.scope = "row"; row.append(product);
      const incomplete = board ? [[total.incomplete_rows, "schedule rows"], [total.incomplete_extra_rows, "additional-board rows"]].filter(([count]) => count > 0).map(([count, label]) => `${displayValue(count)} incomplete ${label}`) : [];
      const status = !board ? total.status : incomplete.length ? `${incomplete.join("; ")} — totals need review` : total.incomplete_rows == null && total.incomplete_extra_rows == null ? "" : "No incomplete rows";
      for (const value of board ? [total.box_reference_area, total.net_board_area, total.whole_sheets, status] : [total.net_bags, total.whole_bags, status]) {
        const cell = node("td", typeof value === "string" ? "calculator-product-order-status" : ""); cell.dataset.calculatorValue = "true"; updateOutputCell(cell, { value });
        if (board && value === status && typeof value === "string" && value) {
          const notes = [[total.incomplete_rows, "{0} incomplete schedule rows"], [total.incomplete_extra_rows, "{0} incomplete additional-board rows"]]
            .filter(([count]) => count > 0).map(([count, source]) => window.CeasefireI18n.term(source, [displayValue(count)]));
          const detail = notes.length > 1 ? window.CeasefireI18n.term("{0}; {1}", notes) : notes[0];
          if (detail) window.CeasefireI18n.text(cell, "{0} — totals need review", [detail]);
          else window.CeasefireI18n.text(cell, "No incomplete rows");
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body); scroll.append(table);
    const cards = node("div", "calculator-summary-cards calculator-summary-three");
    for (const total of result?.spray_schedule_totals || []) {
      const card = node("div", "calculator-summary-metric"), output = node("strong"), label = node("span", "", total.label);
      if (["TOTAL ENTERED SPRAY AREA", "COATING VOLUME QUANTIFIED", "ROWS NOT FULLY QUANTIFIED"].includes(total.label)) window.CeasefireI18n.text(label, total.label);
      output.dataset.calculatorValue = "true"; updateOutputCell(output, { value: total.value }); card.append(label, output); cards.append(card);
    }
    container.replaceChildren(heading, ...(cards.children.length ? [cards] : []), ...(overview ? [overview] : []), ...(note ? [note] : []), scroll);
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
    window.CeasefireI18n.attr(contents, "aria-label", "Worksheet contents"); contents.append(uiNode("p", "calculator-contents-title", "On this page"));
    for (const section of sections) { const link = uiNode("a", `calculator-section-theme-${section.theme}`, section.label); link.href = `#${section.id}`; links.append(link); }
    contents.append(links); return contents;
  }

  function settingsPanels(entry, definitions) {
    const page = currentPage(entry), chooser = node("div", "calculator-settings-chooser"), panels = new Map(), buttons = new Map();
    chooser.setAttribute("role", "group"); window.CeasefireI18n.attr(chooser, "aria-label", "Settings sections");
    entry.settingsSelection ||= {};
    const update = () => {
      for (const [id, panel] of panels) {
        const expanded = entry.settingsSelection[page] === id;
        panel.hidden = !expanded; buttons.get(id).setAttribute("aria-expanded", String(expanded));
      }
    };
    for (const [index, definition] of definitions.entries()) {
      const prefix = `calculator-settings-${entry.definition.id}-${page}-${definition.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
      const button = uiNode("button", `calculator-settings-choice calculator-section-theme-${index % 11}`, definition.label), panel = node("section", "calculator-settings-panel");
      button.type = "button"; button.id = `${prefix}-button`; button.dataset.calculatorSettingsSection = definition.id; button.setAttribute("aria-controls", prefix);
      panel.id = prefix; panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", button.id);
      if (definition.note) panel.append(node("p", "calculator-technical-note calculator-settings-note", definition.note));
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

  function arrangeSettingRows(sourceRows, section) {
    let ordered = sourceRows;
    if (section.promote_rows?.length) {
      const promoted = section.promote_rows.map((number) => sourceRows.find((row) => row.row === number)).filter(Boolean);
      const priorities = new Set(section.promote_rows);
      ordered = sourceRows.filter((row) => !priorities.has(row.row));
      const afterHeader = ordered.findIndex((row) => row.row > section.header_row);
      ordered.splice(afterHeader < 0 ? ordered.length : afterHeader, 0, ...promoted);
    }
    for (const move of section.move_after || []) {
      const moved = move.rows.map((number) => ordered.find((row) => row.row === number)).filter(Boolean);
      const selected = new Set(move.rows);
      ordered = ordered.filter((row) => !selected.has(row.row));
      const anchor = ordered.findIndex((row) => row.row === move.row);
      if (anchor >= 0) ordered.splice(anchor + 1, 0, ...moved);
      else ordered.push(...moved);
    }
    return ordered;
  }

  function renderGrid(entry = current()) {
    if (!entry?.result || entry !== current()) return;
    const grid = $("calculator-grid"), result = entry.result, metadata = displayMetadata(entry), page = pageDefinition(entry);
    const sectionSpacing = Boolean(result.section_spacing ?? metadata.section_spacing);
    grid.classList.toggle("calculator-grid-expanded", Boolean(metadata.expand_tables));
    grid.classList.toggle("calculator-steel-lookup", entry.definition.id === "steel_vermiculite" && entry.sheet === "CALCULATOR");
    entry.productTotalsElement = null;
    entry.boardSteelNotesElement = null;
    const scrollLeft = grid.scrollLeft, scrollTop = grid.scrollTop;
    if (entry.definition.id === "steel_intumescent" && entry.sheet === "SUMMARY" && Array.isArray(result.intumescent_product_totals)) {
      const totals = node("section", "calculator-product-totals"); totals.id = "calculator-product-totals";
      entry.productTotalsElement = totals; renderProductTotals(result, totals);
      grid.replaceChildren(totals); grid.scrollLeft = scrollLeft; grid.scrollTop = scrollTop;
      entry.renderedSheet = entry.sheet; entry.renderedPage = currentPage(entry); entry.choiceSignature = choiceSignature(result); entry.needsRender = false;
      state.gridEntry = entry; return;
    }
    const hidden = hiddenColumns(metadata);
    const registerColumns = entry.sheet === entry.definition.schedule?.sheet && Array.isArray(result.register_columns) ? result.register_columns : null;
    const registerSet = new Set(registerColumns || []), register = entry.definition.schedule;
    const omittedRows = new Set(metadata.omitted_rows), omittedColumns = new Set(metadata.omitted_columns), hiddenAddresses = new Set(metadata.hidden_addresses || []), sourceOmitted = omittedCell(metadata);
    const isOmitted = (row, column) => registerColumns && row >= register.header_row && row <= register.last_row ? !registerSet.has(column) : sourceOmitted(row, column);
    const visibleRows = result.rows.filter((row) => !omittedRows.has(row.row)).map((row) => ({ ...row, cells: row.cells.filter((cell) => !isOmitted(row.row, cell.column)) }));
    let columns = (result.visible_columns || Array.from({ length: result.max_column }, (_, index) => index + 1).filter((column) => !hidden.has(column))).filter((column) => !omittedColumns.has(column));
    const overviewColumns = columns;
    // Schedule-only display columns must not hide overview warnings in the
    // same source columns above the register (for example board warning Y6).
    if (registerColumns) columns = [...registerColumns];
    else if (entry.sheet === entry.definition.schedule?.sheet) {
      const scheduleOmissions = new Set((browserPresentation[entry.definition.id]?.[entry.sheet]?.schedule_omit_columns || []).map(columnNumber));
      columns = columns.filter(column => !scheduleOmissions.has(column));
    }
    columns = [...new Set([...metadata.display_column_order.map(columnNumber).filter((column) => columns.includes(column)), ...columns])];
    if (entry.definition.id === "ductwork" && entry.sheet === entry.definition.schedule?.sheet && columns.includes(3) && columns.includes(9)) {
      columns = columns.filter(column => column !== 3); columns.splice(columns.indexOf(9) + 1, 0, 3);
    }
    const labels = headerLabels(entry, result);
    const schedule = entry.definition.schedule?.sheet === entry.sheet ? entry.definition.schedule : entry.sheet === "EXTRA BOARDS" ? { first_row: 6, last_row: 45, header_row: 5 } : null;
    const showReports = Boolean(schedule && ["steel_vermiculite", "steel_intumescent", "steel_board", "ductwork"].includes(entry.definition.id) && result.rows.some(row => Object.prototype.hasOwnProperty.call(row, "report_references")));
    const reportBefore = showReports ? columns.find(column => /basis|status|sources?|requirements|notes?/i.test(labels[column] || "")) : null;
    const scheduleView = scheduleFor(entry) && result.schedule_view;
    const dynamicSchedule = Boolean(scheduleView && Array.isArray(entry.scheduleRows));
    const deleteReview = dynamicSchedule ? scheduleDeleteContext(entry) : null;
    const virtualSchedule = dynamicSchedule && entry.scheduleRows.length > scheduleWindowSize;
    const syntheticLine = Boolean(schedule?.line_numbers), lineColumn = columnNumber(schedule?.line_id_column), lineWidth = 60;
    const exposureColumns = new Set((schedule?.columns || []).filter((column) => column.editable && /exposure/i.test(column.label)).map((column) => columnNumber(column.column)));
    const presentationTables = metadata.presentation_tables;
    const stackedTables = metadata.table_layout === "stacked" && presentationTables.length > 0;
    const projectedTables = metadata.table_layout === "projected" && presentationTables.length > 0;
    const sourceSettings = metadata.navigation_mode === "select" ? metadata.settings_sections.map((section) => ({ ...section, bounds: section.ranges.map((range) => { const [start, end] = range.split(":").map(parseAddress); return { start, end: end || start }; }) })) : [];
    const settingsDefinitions = sourceSettings.filter((section) => !Array.isArray(page.section_ids) || page.section_ids.includes(section.id));
    const settingsColumns = new Map(settingsDefinitions.map((section) => [section.id, new Set((section.display_columns || []).map(columnNumber))]));
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
        const visibleCell = (row, column) => original.visibleCell(row, column) && sectionOwner(row, column) === owner
          && (!owner || !settingsColumns.get(owner)?.size || settingsColumns.get(owner).has(column));
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
      // Spray input rows can come from both the original report table and the
      // application-only estimating rows. Combine their browser groups before
      // placing controls at the top, without moving any workbook coordinates.
      const firstByOwner = new Map();
      for (const [key, group] of [...sections]) {
        const section = settingsDefinitions.find((item) => item.id === group.settingsSectionId);
        if (!section?.promote_rows?.length || group.definition) continue;
        const first = firstByOwner.get(section.id);
        if (first) {
          first.sourceRows.push(...group.sourceRows);
          first.columns = [...new Set([...first.columns, ...group.columns])].sort((left, right) => left - right);
          sections.delete(key);
        } else firstByOwner.set(section.id, group);
      }
      for (const group of sections.values()) {
        const section = settingsDefinitions.find((item) => item.id === group.settingsSectionId);
        if (!section) continue;
        group.sourceRows = arrangeSettingRows(group.sourceRows, section);
        group.rows = group.sourceRows.map((row) => row.row);
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
    if (syntheticLine) { const heading = uiNode("th", "calculator-line-number", "Line"); heading.scope = "col"; heading.dataset.scheduleColumn = "virtual:line"; headRow.append(heading); }
    for (const column of columns) {
      if (showReports && column === reportBefore) { const heading = uiNode("th", "calculator-report-column", "Report"); heading.scope = "col"; heading.dataset.scheduleColumn = "virtual:report"; headRow.append(heading); }
      const label = String(labels[column] || "");
      const width = schedule ? scheduleColumnWidth(column, label, lineColumn) : Math.max(24, Math.min(320, (Number(metadata.column_widths?.[column]) || 22) * 7));
      widths.push(width);
      const heading = uiNode("th", "", labels[column] || ""); heading.scope = "col"; headRow.append(heading);
      if (schedule) heading.dataset.scheduleColumn = `column:${columnName(column)}`;
      if (schedule?.columns?.some(field => columnNumber(field.column) === column && field.required)) {
        heading.classList.add("calculator-required-heading");
        window.CeasefireI18n.attr(heading, "aria-label", "{0} (required)", [window.CeasefireI18n.term(labels[column] || "")]);
      }
    }
    if (showReports && !reportBefore) { const heading = uiNode("th", "calculator-report-column", "Report"); heading.scope = "col"; heading.dataset.scheduleColumn = "virtual:report"; headRow.append(heading); }
    if (dynamicSchedule) { const heading = uiNode("th", "calculator-row-action", "Actions"); heading.scope = "col"; heading.dataset.scheduleColumn = "virtual:actions"; headRow.append(heading); }
    if (schedule) entry.scheduleColumnChoices = [...(syntheticLine ? [{ id: "virtual:line", label: "Line" }] : []),
      ...columns.flatMap(column => [...(showReports && column === reportBefore ? [{ id: "virtual:report", label: "Report" }] : []), { id: `column:${columnName(column)}`, label: labels[column] || columnName(column) }]),
      ...(showReports && !reportBefore ? [{ id: "virtual:report", label: "Report" }] : []), ...(dynamicSchedule ? [{ id: "virtual:actions", label: "Actions" }] : [])];
    head.append(headRow);
    let introPlaced = false;
    for (const [group, renderedGroup] of sections) for (const row of renderedGroup.sourceRows) {
      const groupColumns = renderedGroup.columns;
      const tr = node("tr"), values = new Map(row.cells.map((cell) => [cell.column, cell]));
      const item = schedule ? row.row - schedule.first_row + 1 : "";
      const reportCell = () => { const cell = node("td", "calculator-report-column"); cell.dataset.scheduleColumn = "virtual:report"; cell.dataset.calculatorReports = String(row.row); renderReportReferences(cell, row.report_references || []); return cell; };
      tr.dataset.sourceRow = String(row.row);
      if (dynamicSchedule) {
        tr.setAttribute("aria-rowindex", String(entry.scheduleRows.indexOf(row.row) + 2));
      }
      if (syntheticLine) { const cell = node("td", "calculator-line-number", item); cell.dataset.scheduleColumn = "virtual:line"; tr.append(cell); }
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
        if (showReports && column === reportBefore) tr.append(reportCell());
        if (boardSummary && column === 10 && row.row >= 11 && row.row <= 29) {
          const steelCell = node(row.row === 11 ? "th" : "td", "calculator-role-output calculator-center calculator-bold");
          if (row.row === 11) { steelCell.scope = "col"; window.CeasefireI18n.text(steelCell, "Net Steel sqm"); }
          else { steelCell.dataset.boardSteelRow = String(row.row); steelCell.dataset.calculatorValue = "true"; updateOutputCell(steelCell, { value: boardSteelValue(result, row.row) }); }
          tr.append(steelCell);
        }
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
        const address = cell.address || `${columnName(column)}${row.row}`;
        const display = browserCellDisplay(entry, address, metadata.display_cells[address] || {});
        let role = display.role || (["SETTINGS", "PRODUCT SETTINGS"].includes(entry.sheet) && column === 1 && row.row === 1 ? "title" : presentationRole(cell));
        if (hasOwnHeader && row.row !== headerRow && role === "column_header" && !section) role = "body";
        if (definition?.table_kind === "form" && role === "section" && !section && !(merge && groupColumns.every((visible) => visible >= merge.start.column && visible <= merge.end.column))) role = "label";
        const explicitHeading = matrixHeading || sourceHeading || Boolean(section) || role === "title";
        if (!explicitHeading && (cell.calculated || cell.output || cell.read_only)) role = "output";
        const td = node(matrixHeading ? "th" : "td", `calculator-role-${role}`);
        if (schedule) td.dataset.scheduleColumn = `column:${columnName(column)}`;
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
          td.append(makeControl(cell, row.row, entry, label, item));
        } else {
          const structural = matrixHeading || sourceHeading || ["title", "compact_title", "compact_summary_title", "section", "column_header"].includes(role);
          const tableValue = Boolean(schedule) || group === "matrix" || Boolean(renderedGroup.definition) || referenceTableValue(entry, row.row, column);
          if (!structural && (tableValue || cell.output || cell.calculated || role === "output" || role !== "label" && cell.value !== null && cell.value !== undefined && cell.value !== "")) td.dataset.calculatorValue = "true";
          td.dataset.calculatorOutput = cell.address || `${columnName(column)}${row.row}`;
          if (virtualSchedule) td.dataset.calculatorVirtualOutput = "true";
          updateOutputCell(td, cell);
          if (sourceHeading) td.classList.add("calculator-source-heading");
        }
        td.hidden = hiddenAddresses.has(address); tr.append(td);
      }
      if (showReports && !groupColumns.includes(reportBefore)) tr.append(reportCell());
      if (dynamicSchedule) {
        const action = node("td", "calculator-row-action");
        action.dataset.scheduleColumn = "virtual:actions";
        for (const binding of window.CeasefireTakeoffs?.scheduleBindings(entry.definition.id, row.row) || []) {
          const source = uiNode("button", "takeoff-source-indicator", "Source"); source.type = "button";
          window.CeasefireI18n.attr(source, "title", "Open takeoff {0}", [binding.item_id]); window.CeasefireI18n.attr(source, "aria-label", "Open takeoff {0}", [binding.item_id]);
          source.addEventListener("click", () => void window.CeasefireTakeoffs.showSource(binding.item_id)); action.append(source);
        }
        action.append(scheduleDeleteButton(row.row, entry, deleteReview)); tr.append(action);
      }
      if (tr.children.length && [...tr.children].every((cell) => cell.hidden)) tr.hidden = true;
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
    const vermiculiteSchedule = Boolean(schedule && entry.definition.id === "steel_vermiculite" && entry.sheet === "SCHEDULE");
    const intumescentSchedule = Boolean(schedule && entry.definition.id === "steel_intumescent" && entry.sheet === "SCHEDULE");
    const scheduleOverview = schedule ? renderOverview(visibleRows.filter((row) => row.row < schedule.header_row), entry, overviewColumns) : null;
    if (scheduleOverview && !boardSchedule && !vermiculiteSchedule && !intumescentSchedule) content.push(scheduleOverview);
    if (entry.definition.id === "steel_vermiculite" && entry.sheet === "BAGS") {
      const totals = node("section", "calculator-product-totals"); totals.id = "calculator-product-totals";
      entry.productTotalsElement = totals; renderProductTotals(result, totals); content.push(totals);
    }
    if (boardSchedule) content.push(scheduleOverview);
    if (schedule?.requirements_note || schedule?.quantity_help) {
      const guidance = node("div", "calculator-schedule-guidance");
      for (const text of [schedule.requirements_note, schedule.quantity_help].filter(Boolean)) guidance.append(uiNode("p", "helper", text));
      content.push(guidance);
    }
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
      if (virtualSchedule) table.classList.add("calculator-virtual-schedule");
      if (dynamicSchedule) { window.CeasefireI18n.attr(table, "aria-label", "{0} schedule", [entry.definition.title]); table.setAttribute("aria-rowcount", String(entry.scheduleRows.length + 1)); }
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
      if (showReports) groupWidths.splice(groupColumns.includes(reportBefore) ? groupColumns.indexOf(reportBefore) : groupWidths.length, 0, 144);
      if (boardSummary && definition?.first_row === 11 && groupColumns.includes(10)) groupWidths.splice(groupColumns.indexOf(10), 0, 170);
      if (syntheticLine) groupWidths.unshift(lineWidth);
      if (dynamicSchedule) groupWidths.push(80);
      if (schedule) table.scheduleColumnLayout = entry.scheduleColumnChoices.map((column, index) => ({ id: column.id, width: groupWidths[index] }));
      const totalWidth = groupWidths.reduce((sum, width) => sum + width, 0);
      for (const width of groupWidths) { const col = node("col"); col.style.width = `${fitWidth ? width / totalWidth * 100 : width}${legacyOrder || fitWidth ? "%" : "px"}`; colgroup.append(col); }
      table.style.width = legacyOrder || fitWidth ? "100%" : `${totalWidth}px`; table.append(colgroup);
      if (schedule) table.append(head);
      if (virtualSchedule) {
        const spacer = (count) => {
          const row = node("tr", "calculator-virtual-spacer"), cell = node("td"); row.setAttribute("aria-hidden", "true");
          cell.colSpan = groupColumns.length + Number(syntheticLine) + Number(dynamicSchedule) + Number(showReports);
          cell.dataset.scheduleSpacer = "true";
          cell.style.height = `${Math.max(0, count) * scheduleRowHeight}px`; row.append(cell); return row;
        };
        body.replaceChildren(spacer(scheduleView.offset), ...body.children, spacer(entry.scheduleRows.length - scheduleView.offset - rows.length));
      }
      table.append(body);
      const scroll = node("div", `calculator-table-scroll${responsive ? " calculator-responsive-scroll" : ""}`);
      if (definition || metadata.expand_tables || !schedule && ["SETTINGS", "PRODUCT SETTINGS"].includes(entry.sheet)) scroll.classList.add("calculator-section-scroll");
      const tableLabel = definition?.label || (group === "matrix" ? matrix.label : null);
      if (tableLabel) { window.CeasefireI18n.attr(table, "aria-label", tableLabel); scroll.setAttribute("role", "region"); window.CeasefireI18n.attr(scroll, "aria-label", "{0} · scroll horizontally for all columns", [window.CeasefireI18n.term(tableLabel)]); scroll.tabIndex = 0; }
      scroll.append(table);
      if (boardSummary && definition?.first_row === 11) {
        const notes = node("div"); notes.id = "calculator-board-steel-notes";
        entry.boardSteelNotesElement = notes;
        notes.append(...(result.board_net_steel_areas ? [result.board_net_steel_areas.basis, ...(result.board_net_steel_areas.notes || [])] : []).map(text => node("p", "helper", text)));
        scroll.append(notes);
      }
      if (dynamicSchedule) {
        scroll.setAttribute("role", "region"); window.CeasefireI18n.attr(scroll, "aria-label", "Schedule rows. Scroll vertically for more rows and horizontally for all columns."); scroll.tabIndex = 0;
        bindScheduleScroll(scroll, entry, scheduleView);
      }
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
        const section = node("section", projectedTables ? "calculator-projected-section" : "calculator-stacked-section"), heading = uiNode("h4", `calculator-section-anchor calculator-section-theme-${link.theme}`, link.label); heading.id = link.id;
        const titleCell = sourceCells.get(definition.title_address);
        applyCellDisplay(heading, metadata.display_cells[definition.title_address]);
        if (titleCell) { heading.dataset.calculatorOutput = definition.title_address; updateOutputCell(heading, titleCell); }
        section.append(heading);
        if (definition.note) section.append(node("p", "calculator-projected-note calculator-technical-note", definition.note));
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
        const section = node("section", "calculator-schedule-section"), heading = uiNode("h4", "", metadata.schedule_heading);
        section.append(heading, scroll); append(section);
      } else append(scroll);
    }
    if (dynamicSchedule) content.push(renderScheduleTools(entry));
    if (settings) content.push(settings.chooser, ...settings.panels.values());
    grid.replaceChildren(...content); grid.scrollLeft = scrollLeft; grid.scrollTop = scrollTop;
    if (dynamicSchedule) for (const scroll of grid.querySelectorAll("[data-schedule-viewport]")) { scroll.scrollTop = entry.scheduleViewport?.top || 0; scroll.scrollLeft = entry.scheduleViewport?.left || 0; }
    entry.renderedSheet = entry.sheet; entry.renderedPage = currentPage(entry); entry.choiceSignature = choiceSignature(result); entry.needsRender = false;
    state.gridEntry = entry;
    syncScheduleColumns(entry);
  }

  let scheduleColumnChooser = null;
  function syncScheduleColumns(entry) {
    const active = entry === current() && entry.sheet === entry.definition.schedule?.sheet && entry.scheduleColumnChoices?.length && !entry.factorView;
    if (!active) { if (scheduleColumnChooser) { scheduleColumnChooser.close(); scheduleColumnChooser.host.hidden = true; } return; }
    scheduleColumnChooser ||= window.CeasefireScheduleColumns.create();
    const key = `${entry.definition.id}:${entry.sheet}`;
    const apply = hidden => {
      if (entry !== current() || entry.sheet !== entry.definition.schedule.sheet) return;
      for (const table of $("calculator-grid").querySelectorAll("table")) window.CeasefireScheduleColumns.applyTable(table, hidden);
    };
    const hidden = scheduleColumnChooser.bind(key, entry.scheduleColumnChoices, apply);
    scheduleColumnChooser.host.hidden = false; $("calculator-pages").append(scheduleColumnChooser.host); apply(hidden);
  }

  function navigationCache(entry, create = false) {
    const inputs = JSON.stringify(entry.inputs);
    if (entry.navigationCache?.revision !== entry.revision || entry.navigationCache?.inputs !== inputs) entry.navigationCache = null;
    if (!entry.navigationCache && create) entry.navigationCache = { revision: entry.revision, inputs, sheets: new Map(), pages: new Map() };
    return entry.navigationCache;
  }

  function retainRecent(map, key, value, limit) {
    map.delete(key); map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  function retainPage(entry) {
    const cache = entry && navigationCache(entry);
    if (!cache || state.gridEntry !== entry || entry.invalid.size || entry.pendingResult || entry.needsRender || cache.sheets.get(entry.sheet) !== entry.result || entry.renderedPage !== currentPage(entry)) return;
    const grid = $("calculator-grid");
    retainRecent(cache.pages, currentPage(entry), { nodes: [...grid.children], result: entry.result, signature: entry.choiceSignature,
      totals: entry.productTotalsElement, steelNotes: entry.boardSteelNotesElement, scrollLeft: grid.scrollLeft, scrollTop: grid.scrollTop,
      optionNodes: [...$("calculator-option-lists").children], optionLists: new Map(state.optionLists), optionKeys: state.optionKeys,
      expanded: grid.classList.contains("calculator-grid-expanded") }, 3);
  }

  function showCalculationStatus(entry, result) {
    const copiedFixingNote = "The copied fixing instructions use the first schedule row’s fixed technical references on every row. This is the approved correction to the source workbook; quantity formulas are unchanged.";
    const hideCopiedFixingNote = entry.definition.id === "ductwork" && ["CALCULATOR", "SUMMARY", "PRODUCT SETTINGS"].includes(entry.sheet);
    const warnings = (result.warnings || []).map((warning) => typeof warning === "string" ? warning : warning.message || warning.label || "").filter((warning) => warning && !(hideCopiedFixingNote && warning === copiedFixingNote));
    if (result.required_review_rows?.length) warnings.unshift(window.CeasefireI18n.translate("Complete required fields on {0} schedule row(s).", [result.required_review_rows.length]));
    $("calculator-warnings").textContent = warnings.join("\n"); $("calculator-warnings").hidden = !warnings.length;
    calculationStatus(); updateStatus(entry);
  }

  function latestCells(entry, result) {
    entry.latestCells = new Map(result.rows.flatMap((row) => row.cells.map((cell) => [`${entry.sheet}!${cell.address || `${columnName(cell.column)}${row.row}`}`, cell])));
  }

  async function navigateWorksheet(entry) {
    // Cached navigation must invalidate earlier requests just like a new request.
    ++state.requestRevision; clearTimeout(state.timer);
    if (entry.invalid.size && entry.result) {
      state.calculating = false;
      renderGrid(entry); $("calculator-grid").setAttribute("aria-busy", "false"); updateStatus(entry); return;
    }
    const cache = navigationCache(entry), page = currentPage(entry), view = cache?.pages.get(page), result = cache?.sheets.get(entry.sheet);
    entry.pendingResult = null; entry.needsRender = true;
    if (result) {
      state.calculating = false;
      entry.result = result; latestCells(entry, result);
      if (view && view.result === result) {
        const grid = $("calculator-grid"); grid.replaceChildren(...view.nodes);
        $("calculator-option-lists").replaceChildren(...view.optionNodes); state.optionLists = new Map(view.optionLists); state.optionKeys = view.optionKeys;
        grid.classList.toggle("calculator-grid-expanded", view.expanded);
        grid.classList.toggle("calculator-steel-lookup", entry.definition.id === "steel_vermiculite" && entry.sheet === "CALCULATOR");
        grid.scrollLeft = view.scrollLeft; grid.scrollTop = view.scrollTop;
        entry.productTotalsElement = view.totals; entry.boardSteelNotesElement = view.steelNotes; entry.choiceSignature = view.signature;
        entry.renderedSheet = entry.sheet; entry.renderedPage = page; entry.needsRender = false; state.gridEntry = entry;
        refreshScheduleDeleteControls(entry);
        syncScheduleColumns(entry);
        retainRecent(cache.pages, page, view, 3);
      } else renderGrid(entry);
      $("calculator-grid").setAttribute("aria-busy", "false"); showCalculationStatus(entry, result); return;
    }
    entry.result = null; state.gridEntry = null;
    $("calculator-grid").replaceChildren(uiNode("p", "calculator-empty", "Loading this worksheet…"));
    await calculate({ navigation: true });
  }

  async function calculate(options = {}) {
    const entry = current(); if (!entry || entry.invalid.size) return;
    clearTimeout(state.timer);
    if (!options.navigation) entry.navigationCache = null;
    const revision = entry.revision, sheet = entry.sheet, page = currentPage(entry), serial = ++state.requestRevision;
    state.calculating = true; updateStatus(entry);
    calculationStatus(uiCopy("Calculating…"));
    $("calculator-grid").setAttribute("aria-busy", "true");
    try {
      const schedule = scheduleFor(entry);
      const body = JSON.stringify({ inputs: clone(entry.inputs), sheet, include_advanced: Boolean(schedule),
        ...(schedule ? { schedule_view: { ...(Array.isArray(entry.scheduleRows) ? { rows: [...entry.scheduleRows] } : {}), offset: entry.scheduleViewport?.offset || 0, limit: scheduleWindowSize } } : {}) });
      const result = await calculationQueue.run(() => request(endpoint(entry.definition.id, "worksheet"), { method: "POST", body }),
        () => current() === entry && serial === state.requestRevision && revision === entry.revision && sheet === entry.sheet && page === currentPage(entry) && !entry.invalid.size);
      if (!result) return;
      if (current() !== entry || serial !== state.requestRevision || revision !== entry.revision || sheet !== entry.sheet || page !== currentPage(entry)) return;
      if (result.inputs) entry.inputs = clone(result.inputs);
      if (result.schedule_view) {
        if (!Array.isArray(entry.scheduleRows)) entry.savedRows = JSON.stringify(result.schedule_view.rows);
        entry.scheduleRows = [...result.schedule_view.rows];
        entry.scheduleViewport ||= { top: 0, left: 0 };
        entry.scheduleViewport.offset = result.schedule_view.offset;
      }
      const cache = navigationCache(entry, true);
      retainRecent(cache.sheets, sheet, result, 5); cache.pages.delete(page);
      latestCells(entry, result);
      const active = document.activeElement;
      const canRefresh = !entry.needsRender && entry.renderedSheet === sheet && entry.renderedPage === page && entry.choiceSignature === choiceSignature(result);
      entry.result = result;
      if (canRefresh) { entry.pendingResult = null; refreshOutputs(result); refreshScheduleDeleteControls(entry); }
      else if (!entry.needsRender && (active?.dataset?.calculatorCell || active?.dataset?.calculatorCustomCell) && active.dataset.calculatorSheet === sheet) { entry.pendingResult = result; refreshOutputs(result); }
      else { entry.pendingResult = null; renderGrid(entry); }
      showCalculationStatus(entry, result);
    } catch (error) {
      if (current() === entry && serial === state.requestRevision && revision === entry.revision && page === currentPage(entry)) { message(uiCopy("Could not calculate. {0}", [error.message]), true); calculationStatus(uiCopy("Calculation needs attention")); }
    } finally { if (serial === state.requestRevision) { state.calculating = false; $("calculator-grid").setAttribute("aria-busy", "false"); updateStatus(entry); } }
  }

  async function selectPage(id) {
    const entry = current(), page = entry && displayPages(entry.definition, entry.factorView).find((item) => item.id === id); if (!page) return;
    if (id === currentPage(entry) && state.gridEntry === entry && entry.result && !entry.needsRender) return;
    if (entry.invalid.size) { message(uiCopy("Correct the invalid number before changing pages."), true); return; }
    retainPage(entry);
    entry.page = page.id; entry.sheet = page.sheet;
    window.CeasefireI18n.text($("calculator-sheet-title"), page.label);
    renderPages(entry); message(); await navigateWorksheet(entry);
  }

  function renderPages(entry) {
    const buttons = displayPages(entry.definition, entry.factorView).map((page) => {
      const button = uiNode("button", "calculator-page", page.label); button.type = "button";
      button.setAttribute("aria-pressed", String(page.id === currentPage(entry))); button.addEventListener("click", () => selectPage(page.id)); return button;
    });
    $("calculator-pages").replaceChildren(...buttons);
    $("calculator-pages").hidden = Boolean(entry.factorView);
    syncScheduleColumns(entry);
  }

  function safeDocumentUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try { const url = new URL(value, window.location.origin); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }

  function renderDocuments(entry) {
    const groups = new Map();
    for (const document of entry.definition.documents || []) {
      const url = safeDocumentUrl(document.url); if (!url && document.reference_only !== true) continue;
      const product = Array.isArray(document.products) && document.products.length ? document.products.join(" / ") : "Source information";
      if (!groups.has(product)) groups.set(product, []);
      const card = node("article", "calculator-document-card");
      if (/request/i.test(`${document.kind || ""} ${document.availability || ""}`)) card.classList.add("calculator-document-request");
      const metadata = [document.kind, document.availability].filter(Boolean).join(" · ");
      if (metadata) card.append(node("p", "calculator-document-meta", metadata));
      const link = node(url ? "a" : "p", "calculator-document-link", document.title || "Technical document");
      if (url) { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
      card.append(link);
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
    const firestopping = Boolean(window.CeasefireProposalCalculators?.isFirestopping?.());
    for (const button of $("calculator-navigation-menu")?.querySelectorAll("[data-calculator-id]") || []) {
      const selected = current()?.factorView ? "steel_factors" : state.current;
      button.setAttribute("aria-pressed", String(button.dataset.calculatorId === "penetration" ? firestopping : !firestopping && (button.dataset.calculatorId === "steel" ? window.CeasefireProposalCalculators?.isSteelHub?.() || ["steel_vermiculite", "steel_intumescent", "steel_board"].includes(state.current) : button.dataset.calculatorId === selected)));
    }
  }

  function canSelect(id) {
    const entry = current(), canonical = id === "steel_factors" ? "steel_vermiculite" : id;
    if (entry && canonical === state.current && Boolean(entry.factorView) !== (id === "steel_factors") && entry.invalid.size) {
      message(uiCopy("Correct the invalid number before changing pages."), true); return false;
    }
    return true;
  }

  async function selectCalculator(requestedId) {
    if (!canSelect(requestedId)) return;
    const factorView = requestedId === "steel_factors", id = factorView ? "steel_vermiculite" : requestedId;
    const serial = ++state.loadRevision;
    window.CeasefireProposalCalculators?.showWorkbook?.();
    if (id === state.current && Boolean(current()?.factorView) === factorView && state.gridEntry === current() && current()?.result && !current().needsRender) {
      refreshScheduleDeleteControls(current());
      $("calculator-workspace").hidden = false; renderChoices(); return;
    }
    try {
      let entry = state.entries.get(id);
      if (!entry) {
        const definition = await calculatorDefinition(id);
        if (serial !== state.loadRevision || window.CeasefireProposalCalculators?.isFirestopping?.()) return;
        const inputs = clone(definition.inputs || {});
        const page = displayPages(definition)[0];
        entry = state.entries.get(id) || { definition, inputs, saved: JSON.stringify(inputs), scheduleRows: definition.schedule_rows && [...definition.schedule_rows], savedRows: JSON.stringify(definition.schedule_rows), revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() };
        state.entries.set(id, entry);
      }
      if (serial !== state.loadRevision || window.CeasefireProposalCalculators?.isFirestopping?.()) return;
      retainPage(current());
      if (Boolean(entry.factorView) !== factorView) {
        if (factorView) entry.standardPage = currentPage(entry);
        entry.factorView = factorView;
        const pages = displayPages(entry.definition, factorView);
        const page = pages.find(page => page.id === (factorView ? "FACTOR CALCS" : entry.standardPage)) || pages[0];
        entry.page = page.id; entry.sheet = page.sheet;
      }
      state.current = id; ++state.requestRevision; clearTimeout(state.timer);
      $("calculator-workspace").hidden = false; $("calculator-workspace").dataset.calculatorKind = entry.definition.id; window.CeasefireI18n.text($("calculator-title"), factorView ? "Factor Calcs" : entry.definition.id === "ductwork" ? "Duct" : entry.definition.title);
      window.CeasefireI18n.text($("calculator-workspace").querySelector(".eyebrow"), entry.definition.id === "ductwork" ? "DUCT CALCULATOR" : "STEEL CALCULATOR");
      window.CeasefireI18n.text($("calculator-sheet-title"), pageDefinition(entry).label);
      renderChoices(); renderPages(entry); renderDocuments(entry); updateStatus(entry); message();
      await navigateWorksheet(entry);
    } catch (error) { if (serial === state.loadRevision && !window.CeasefireProposalCalculators?.isFirestopping?.()) message(uiCopy("Could not open the calculator. {0}", [error.message]), true); }
  }

  async function open() {
    const serial = ++state.loadRevision;
    try {
      const list = await calculatorList();
      if (serial !== state.loadRevision || window.CeasefireProposalCalculators?.isFirestopping?.()) return;
      renderChoices();
      if (list.length) await selectCalculator(state.current || list[0].id);
    } catch (error) { if (serial === state.loadRevision && !window.CeasefireProposalCalculators?.isFirestopping?.()) message(uiCopy("Could not load the calculators. {0}", [error.message]), true); }
  }

  function confirmReplace(title, detail, buttonText, cancelText = uiCopy("Keep editing")) {
    const dialog = $("calculator-confirm-dialog");
    uiText($("calculator-confirm-title"), title); uiText($("calculator-confirm-detail"), detail); uiText($("calculator-confirm-button"), buttonText);
    uiText($("calculator-confirm-cancel"), cancelText); dialog.returnValue = "cancel";
    return new Promise((resolve) => { dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); dialog.showModal(); });
  }

  async function save() {
    const entry = current(); if (!entry || entry.invalid.size || state.action) return;
    state.action = true; updateStatus();
    const snapshot = clone(entry.inputs), rows = scheduleState(entry), revision = entry.revision;
    try {
      const response = await request(endpoint(entry.definition.id, "state"), { method: "PUT", body: JSON.stringify({ inputs: snapshot, ...rows }) });
      const saved = clone(response.inputs || snapshot); entry.saved = JSON.stringify(saved);
      entry.savedRows = JSON.stringify(response.schedule_rows || rows.schedule_rows);
      if (entry.revision === revision) { entry.inputs = saved; entry.scheduleRows = response.schedule_rows || rows.schedule_rows; }
      message(entry.revision === revision ? uiCopy("{0} saved.", [entry.definition.title]) : uiCopy("Calculator saved. Your later edits are still unsaved."));
    } catch (error) { message(uiCopy("Could not save the calculator. {0}", [error.message]), true); }
    finally { state.action = false; updateStatus(); if (current() === entry && state.gridEntry === entry) refreshScheduleDeleteControls(entry); }
  }

  async function reset() {
    const entry = current(); if (!entry || state.action) return;
    state.action = true; updateStatus(); const revision = entry.revision;
    try {
      if (!await confirmReplace(uiCopy("Reset calculator defaults?"), uiCopy("This clears all rows and resets the schedule."), uiCopy("Reset"))) return;
      if (current() !== entry || entry.revision !== revision) { message(uiCopy("The calculator changed while the confirmation was open. Review the latest draft and try again."), true); return; }
      entry.inputs = clone(entry.definition.defaults || {}); entry.invalid.clear(); entry.revision++; entry.pendingResult = null; entry.navigationCache = null; entry.needsRender = true;
      if (entry.definition.schedule) entry.scheduleRows = [entry.definition.schedule.first_row];
      entry.scheduleViewport = null; entry.removedRows = [];
      message(uiCopy("Calculator defaults restored in this draft. Use Save to keep them.")); await calculate();
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
    if (file.size > 5 * 1024 * 1024) { message(uiCopy("Choose an Excel workbook smaller than 5 MB."), true); return; }
    if (!file.name.toLowerCase().endsWith(".xlsx")) { message(uiCopy("Choose an .xlsx schedule workbook."), true); return; }
    state.action = true; updateStatus(); const revision = entry.revision, snapshot = clone(entry.inputs);
    try {
      const content = await readFile(file);
      const result = await request(endpoint(entry.definition.id, "import"), { method: "POST", body: JSON.stringify({ filename: file.name, content_base64: content, inputs: snapshot }) });
      if (current() !== entry || entry.revision !== revision) { message(uiCopy("The calculator changed while the file was importing. Your edits were kept; import the file again to review it."), true); return; }
      if (!await confirmReplace(uiCopy("Replace the schedule draft?"), uiCopy("{0} schedule rows are ready to import. The imported schedule replaces the current schedule in this draft. Review the results, then click Save.", [result.imported_rows]), uiCopy("Apply to draft"))) return;
      if (current() !== entry || entry.revision !== revision) { message(uiCopy("The calculator changed while the confirmation was open. Your edits were kept; import the file again."), true); return; }
      entry.inputs = clone(result.inputs); entry.invalid.clear(); entry.revision++; entry.pendingResult = null; entry.navigationCache = null; entry.needsRender = true;
      entry.scheduleRows = result.schedule_rows && [...result.schedule_rows]; entry.scheduleViewport = null; entry.removedRows = [];
      message(uiCopy("Imported {0} schedule rows into the draft. Use Save to keep them.", [result.imported_rows])); await calculate();
    } catch (error) { message(uiCopy("Could not import the schedule. {0}", [error.message]), true); }
    finally { state.action = false; updateStatus(); }
  }

  async function exportTemplate() {
    const entry = current(); if (!entry || state.action) return;
    const button = $("calculator-template");
    state.action = true; updateStatus();
    try {
      const saved = await window.CeasefireDownloads.save(endpoint(entry.definition.id, "template"), {}, { button });
      message(uiCopy("Schedule template saved to {0}. Complete its input columns, then use Import Schedule.", [saved.path]));
    } catch (error) { message(uiCopy("Could not export the template. {0}", [error.message]), true); }
    finally { state.action = false; updateStatus(); }
  }

  async function downloadCalculatedFile({ action, buttonId, label, includeProjectDetails = false }) {
    const entry = current(); if (!entry || entry.invalid.size || state.action) return;
    // Input events retain exact edits; blur completes dropdown validation before
    // the server calculates the captured draft for the downloaded file.
    const focused = document.activeElement;
    if ((focused?.dataset?.calculatorCell || focused?.dataset?.calculatorCustomCell) && focused.dataset.calculatorSheet === entry.sheet) focused.blur();
    if (current() !== entry || entry.invalid.size) return;
    const id = entry.definition.id, snapshot = clone(entry.inputs), revision = entry.revision;
    const projectDetails = includeProjectDetails ? clone(window.CeasefireProject?.details() || {}) : null;
    const button = $(buttonId), previousLabel = button.getAttribute("aria-label") || label;
    state.action = true; updateStatus();
    window.CeasefireI18n.attr(button, "aria-label", "Preparing {0}…", [window.CeasefireI18n.term(label)]); button.setAttribute("aria-busy", "true");
    try {
      const saved = await window.CeasefireDownloads.save(endpoint(id, action), { inputs: snapshot, ...(projectDetails ? { project_details: projectDetails } : {}) }, { button });
      const changed = current() !== entry || entry.revision !== revision || projectDetails && JSON.stringify(projectDetails) !== JSON.stringify(window.CeasefireProject?.details() || {});
      message(uiCopy("{0} saved to {1} using the {2} draft captured when you clicked Download.{3}", [window.CeasefireI18n.term(label), saved.path, entry.definition.title, window.CeasefireI18n.term(changed ? " Your current draft was kept; later edits are not included." : "")]));
    } catch (error) { message(uiCopy("Could not download the {0}. {1}", [window.CeasefireI18n.term(label), error.message]), true); }
    finally { button.setAttribute("aria-label", previousLabel); button.removeAttribute("aria-busy"); state.action = false; updateStatus(); }
  }

  function downloadSchedulePdf() {
    return downloadCalculatedFile({ action: "report.pdf", buttonId: "calculator-pdf", label: documentLabels()["calculator-pdf"], includeProjectDetails: true });
  }

  function downloadExcelRegister() {
    return downloadCalculatedFile({ action: "register.xlsx", buttonId: "calculator-excel", label: documentLabels()["calculator-excel"] });
  }

  function downloadMaterialsSummaryPdf() {
    return downloadCalculatedFile({ action: "summary.pdf", buttonId: "calculator-summary-pdf", label: documentLabels()["calculator-summary-pdf"], includeProjectDetails: true });
  }

  // Document disclosures only change access to the existing action buttons.
  // Their click handlers still own validation, draft capture and file saving.
  function initializeDocumentMenus() {
    const menus = [...document.querySelectorAll?.(".calculator-document-menu") || []].map((root) => ({
      root, toggle: root.querySelector("[data-document-menu-toggle]"), list: root.querySelector("[data-document-menu-list]"),
    })).filter(({ toggle, list }) => toggle && list);
    const buttons = (menu) => [...menu.list.querySelectorAll("button")].filter((button) => !button.disabled && !button.hidden);
    const close = (menu, restoreFocus = false) => {
      menu.list.hidden = true; menu.toggle.setAttribute("aria-expanded", "false");
      if (restoreFocus) menu.toggle.focus();
    };
    const open = (menu) => {
      for (const other of menus) if (other !== menu) close(other);
      menu.list.hidden = false; menu.toggle.setAttribute("aria-expanded", "true");
    };
    for (const menu of menus) {
      close(menu);
      menu.toggle.addEventListener("click", () => menu.list.hidden ? open(menu) : close(menu));
      menu.root.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.list.hidden) { event.preventDefault(); close(menu, true); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); open(menu);
        const choices = buttons(menu); if (!choices.length) return;
        const index = choices.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
          : event.key === "ArrowDown" ? (index + 1) % choices.length : (index < 0 ? choices.length - 1 : (index + choices.length - 1) % choices.length);
        choices[next].focus();
      });
      menu.list.addEventListener("click", (event) => {
        if (event.target.closest("button")) close(menu, true);
      });
      menu.root.addEventListener("focusout", (event) => { if (!menu.root.contains(event.relatedTarget)) close(menu); });
    }
    window.addEventListener("pointerdown", (event) => { for (const menu of menus) if (!menu.root.contains(event.target)) close(menu); });
  }

  initializeDocumentMenus();

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
    return Object.fromEntries([...state.entries].map(([id, entry]) => [id, { inputs: clone(entry.inputs), ...scheduleState(entry) }]));
  }

  function projectFingerprint(action = state.action) {
    return JSON.stringify({ action, entries: [...state.entries].map(([id, entry]) => [id, entry.inputs, entry.saved, entry.scheduleRows, entry.savedRows, [...entry.invalid]]) });
  }

  function preparedProject(list, definitions, calculators) {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    const entries = definitions.map(definition => {
      const id = definition.id;
      if (!calculators[id]?.inputs) throw new Error("The project is missing a calculator.");
      const page = displayPages(definition)[0];
      return [id, { definition, inputs: clone(calculators[id].inputs), saved: null, scheduleRows: calculators[id].schedule_rows && [...calculators[id].schedule_rows], savedRows: JSON.stringify(calculators[id].schedule_rows), revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() }];
    });
    return { list, entries };
  }

  async function prepareProject(calculators) {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    const list = await calculatorList();
    // Project preparation has a separate lifetime from navigation. An older
    // first-open read must not delay loading or populate the previous draft.
    const definitions = await Promise.all(list.map(async ({ id }) => state.entries.get(id)?.definition || await request(endpoint(id))));
    return preparedProject(list, definitions, calculators);
  }

  function applyProject(prepared) {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    ++state.loadRevision; ++state.requestRevision; clearTimeout(state.timer);
    state.entries = new Map(prepared.entries); state.list = prepared.list; state.current = null;
    state.gridEntry = null;
    state.optionLists.clear(); state.optionKeys = new WeakMap(); state.nextListId = 0;
    $("calculator-option-lists").replaceChildren(); $("calculator-grid").replaceChildren();
    $("calculator-workspace").hidden = true; renderChoices(); message();
  }

  async function prepareDefaults() {
    if (state.action) throw new Error("Wait for the current calculator action to finish.");
    const list = await calculatorList();
    const definitions = await Promise.all(list.map(async ({ id }) => state.entries.get(id)?.definition || await request(endpoint(id))));
    const calculators = Object.fromEntries(definitions.map(definition => [definition.id, { inputs: clone(definition.defaults || {}), ...(definition.schedule ? { schedule_rows: [definition.schedule.first_row] } : {}) }]));
    const prepared = preparedProject(list, definitions, calculators);
    for (const [, entry] of prepared.entries) entry.saved = JSON.stringify(entry.inputs);
    return prepared;
  }

  function markProjectSaved(calculators, captured) {
    for (const [id, entry] of state.entries) {
      const receipt = calculators[id], snapshot = captured?.[id];
      if (!receipt?.inputs) continue;
      const saved = JSON.stringify(receipt.inputs), savedRows = JSON.stringify(receipt.schedule_rows);
      // A server may canonicalize approved aliases. Adopt only the exact draft
      // captured by this save; later edits and unfinished input remain untouched.
      if (snapshot && !entry.invalid.size && JSON.stringify(entry.inputs) === JSON.stringify(snapshot.inputs)
          && JSON.stringify(entry.scheduleRows) === JSON.stringify(snapshot.schedule_rows)
          && (JSON.stringify(entry.inputs) !== saved || JSON.stringify(entry.scheduleRows) !== savedRows)) {
        entry.inputs = clone(receipt.inputs); entry.scheduleRows = receipt.schedule_rows && [...receipt.schedule_rows];
        entry.revision++; entry.pendingResult = null; entry.navigationCache = null; entry.needsRender = true;
        if (current() === entry) {
          if (state.gridEntry === entry && entry.result) refreshOutputs(entry.result);
          clearTimeout(state.timer);
          state.timer = setTimeout(() => { if (current() === entry) calculate(); }, 550);
        }
      }
      entry.saved = saved; entry.savedRows = savedRows;
    }
    updateStatus();
  }
  function hasUnsavedChanges() { return [...state.entries.values()].some(entry => dirty(entry) || entry.invalid.size); }

  async function completeProjectSnapshot() {
    const list = await calculatorList();
    const context = state.entries;
    const definitions = await Promise.all(list.filter(({ id }) => !context.has(id)).map(({ id }) => request(endpoint(id))));
    if (state.entries !== context) throw new Error("The project changed while reading calculator inputs. Save it again when ready.");
    state.list = list;
    for (const definition of definitions) {
      if (context.has(definition.id)) continue;
      const inputs = clone(definition.inputs || {}), page = displayPages(definition)[0];
      context.set(definition.id, { definition, inputs, saved: JSON.stringify(inputs), scheduleRows: definition.schedule_rows && [...definition.schedule_rows], savedRows: JSON.stringify(definition.schedule_rows), revision: 0, page: page.id, sheet: page.sheet, needsRender: true, result: null, pendingResult: null, labels: {}, invalid: new Map() });
    }
    return projectSnapshot();
  }

  // The public takeoff bridge captures a complete calculator draft. Only a
  // server-validated preview may replace it, under an exclusive short lease.
  function readTakeoffTarget(id) {
    const entry = state.entries.get(id);
    if (state.action || !entry?.definition.schedule || !Array.isArray(entry.scheduleRows) || entry.invalid.size) throw new Error("The current calculator schedule is unavailable or has invalid inputs.");
    return { inputs: clone(entry.inputs), ...scheduleState(entry), fingerprint: projectFingerprint() };
  }
  async function captureTakeoffTarget(id) {
    document.activeElement?.blur?.();
    await completeProjectSnapshot();
    if (state.action) throw new Error("Finish the current calculator action first.");
    const entry = state.entries.get(id);
    if (!entry?.definition.schedule || entry.invalid.size) throw new Error("Choose a valid calculator schedule and correct its input errors first.");
    return { inputs: clone(entry.inputs), ...scheduleState(entry), fingerprint: projectFingerprint() };
  }
  function reserveTakeoffTarget(id, fingerprint) {
    document.activeElement?.blur?.();
    if (state.action || projectFingerprint() !== fingerprint) throw new Error("The calculator changed during transfer review. Preview the transfer again.");
    const entry = state.entries.get(id);
    if (!entry || entry.invalid.size) throw new Error("The destination calculator is unavailable or has invalid inputs.");
    const reservation = { id, entry, entries: state.entries, inputs: JSON.stringify(entry.inputs), rows: JSON.stringify(entry.scheduleRows), revision: entry.revision };
    state.takeoffReservation = reservation; state.action = true; clearTimeout(state.timer); ++state.requestRevision;
    for (const control of $("calculator-grid").querySelectorAll("input,select,textarea,button")) control.disabled = true;
    updateStatus(); return reservation;
  }
  function applyTakeoffTarget(id, transferred, reservation) {
    const entry = state.entries.get(id);
    if (!reservation || state.takeoffReservation !== reservation || id !== reservation.id || entry !== reservation.entry || state.entries !== reservation.entries
        || entry.revision !== reservation.revision || JSON.stringify(entry.inputs) !== reservation.inputs || JSON.stringify(entry.scheduleRows) !== reservation.rows) throw new Error("The calculator changed while applying the transfer. Reopen the transfer before proceeding.");
    if (transferred?.calculator_id !== id || !transferred.inputs || !Array.isArray(transferred.schedule_rows)) throw new Error("The transfer response does not contain a complete destination schedule.");
    entry.inputs = clone(transferred.inputs); entry.scheduleRows = [...transferred.schedule_rows]; entry.invalid.clear(); entry.scheduleViewport = null; entry.removedRows = [];
    scheduleChanged(entry); entry.result = null;
    return { inputs: clone(entry.inputs), ...scheduleState(entry) };
  }
  function releaseTakeoffTarget(reservation) {
    if (state.takeoffReservation !== reservation) return;
    state.takeoffReservation = null; state.action = false;
    const entry = current();
    if (entry) { entry.needsRender = true; void calculate(); }
    updateStatus();
  }

  async function captureTakeoffTargets(ids) {
    document.activeElement?.blur?.();
    await completeProjectSnapshot();
    if (state.action) throw new Error("Finish the current calculator action first.");
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error("Choose distinct linked calculator schedules.");
    const calculators = {};
    for (const id of ids) {
      const entry = state.entries.get(id);
      if (!entry?.definition.schedule || entry.invalid.size) throw new Error("A linked calculator is unavailable or has invalid inputs.");
      calculators[id] = { inputs: clone(entry.inputs), ...scheduleState(entry) };
    }
    return { calculators, fingerprint: projectFingerprint() };
  }
  function reserveTakeoffTargets(ids, fingerprint) {
    document.activeElement?.blur?.();
    if (state.action || projectFingerprint() !== fingerprint) throw new Error("The calculator changed during linked deletion review. Review the current draft again.");
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error("Choose distinct linked calculator schedules.");
    const targets = ids.map(id => {
      const entry = state.entries.get(id);
      if (!entry?.definition.schedule || entry.invalid.size) throw new Error("A linked calculator is unavailable or has invalid inputs.");
      return { id, entry, inputs: JSON.stringify(entry.inputs), rows: JSON.stringify(entry.scheduleRows), revision: entry.revision };
    });
    const reservation = { targets, entries: state.entries };
    state.takeoffReservation = reservation; state.action = true; clearTimeout(state.timer); ++state.requestRevision;
    for (const control of $("calculator-grid").querySelectorAll("input,select,textarea,button")) control.disabled = true;
    updateStatus(); return reservation;
  }
  function applyTakeoffTargets(calculators, reservation) {
    if (!reservation?.targets || state.takeoffReservation !== reservation || state.entries !== reservation.entries) throw new Error("The calculators changed while applying the linked edit.");
    if (!calculators || Object.keys(calculators).length !== reservation.targets.length) throw new Error("The linked edit response does not contain every destination schedule.");
    // Validate and clone the complete batch before changing any calculator.
    const prepared = reservation.targets.map(target => {
      const { id, entry } = target, changed = calculators[id];
      if (state.entries.get(id) !== entry || entry.revision !== target.revision || JSON.stringify(entry.inputs) !== target.inputs || JSON.stringify(entry.scheduleRows) !== target.rows) throw new Error("The calculators changed while applying the linked edit.");
      if (!changed?.inputs || !Array.isArray(changed.schedule_rows)) throw new Error("The linked edit response does not contain every destination schedule.");
      return { entry, inputs: clone(changed.inputs), rows: [...changed.schedule_rows] };
    });
    for (const { entry, inputs, rows } of prepared) {
      entry.inputs = inputs; entry.scheduleRows = rows; entry.invalid.clear(); entry.scheduleViewport = null; entry.removedRows = [];
      scheduleChanged(entry); entry.result = null;
    }
  }

  window.CeasefireCalculators = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject };
  Object.assign(window.CeasefireCalculators, { select: selectCalculator, canSelect, refreshNavigation: renderChoices, hide() { ++state.loadRevision; scheduleColumnChooser?.close(); $("calculator-workspace").hidden = true; } });
  Object.assign(window.CeasefireCalculators, { prepareDefaults, markProjectSaved, hasUnsavedChanges, completeProjectSnapshot });
  Object.assign(window.CeasefireCalculators, { hasPendingOperation: () => !!state.action });
  Object.assign(window.CeasefireCalculators, { readTakeoffTarget, captureTakeoffTarget, reserveTakeoffTarget, applyTakeoffTarget, releaseTakeoffTarget });
  Object.assign(window.CeasefireCalculators, { captureTakeoffTargets, reserveTakeoffTargets, applyTakeoffTargets });
})();
