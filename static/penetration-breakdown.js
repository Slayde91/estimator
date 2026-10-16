(() => {
  "use strict";
  // Bind application-owned copy only; node() remains safe for user and source text.
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index])); return element;
  };
  const uiAttr = (element, name, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.attr(element, name, source, args);
    const value = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
    element.setAttribute(name, value); if (["title", "placeholder"].includes(name)) element[name] = value; return element;
  };
  const uiNode = (tag, cls, source, args = []) => { const element = node(tag, cls); return window.CeasefireI18n?.nodeText ? window.CeasefireI18n.nodeText(element, source, args) : uiText(element, source, args); };
  const uiTerm = (source, args = []) => window.CeasefireI18n?.term ? window.CeasefireI18n.term(source, args) : String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(args[index]));
  // These names describe application task rows and quantity contexts. Product
  // names and unexpected source labels never enter a translation binding.
  const taskLabels = new Set(["Labour", "Additional Labour", "Register allowance", "Board", "Collars", "Mastic", "Framing", "Wrap", "Other"]);
  const quantityContexts = Object.freeze({ CJ: "Substrate", CQ: "Bulkhead", AN: "Collars", AC: "Mastic Qty", CU: "Bulkhead", BS: "Pipes", CB: "Cabletrays", AF: "Additional material" });
  const inputError = value => typeof value === "string" && /^#(?:VALUE!|REF!|NUM!|DIV\/0!|N\/A|NAME\?|NULL!|CALC!)/.test(value);

  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const percent = new Intl.NumberFormat("en-AU", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const node = (tag, className = "", text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
  function display(value, format) {
    if (value === null || value === undefined || value === "") return "—";
    if (inputError(value)) return "Check inputs";
    if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
    return format === "currency" ? currency.format(value) : format === "percent" ? percent.format(value) : number.format(value);
  }
  const displayNode = (tag, value, format) => inputError(value) ? uiNode(tag, "", "Check inputs") : node(tag, "", display(value, format));
  function details(values, format) {
    const cell = node("td");
    if (!Array.isArray(values) || !values.length) { cell.textContent = "—"; return cell; }
    for (const value of values) {
      const entry = node("div", "penetration-breakdown-value");
      if (value.label) entry.append(contextLabel(value));
      entry.append(inputError(value.value) ? uiNode("span", "", "{0}{1}", [uiTerm("Check inputs"), value.units ? ` ${value.units}` : ""]) : node("span", "", `${display(value.value, value.format || format)}${value.units ? ` ${value.units}` : ""}`)); cell.append(entry);
    }
    return cell;
  }
  function contextLabel(value) {
    const label = value.label, context = Object.hasOwn(quantityContexts, value.column) ? quantityContexts[value.column] : null, cls = "penetration-breakdown-context";
    if (context && label === context && !value.product) return uiNode("span", cls, context);
    if (Object.hasOwn(value, "product")) {
      // The server supplies product identity separately from its composed label.
      // Verify that composition before localizing only its application context.
      if (value.product && context && label === `${value.product} · ${context}`) return uiNode("span", cls, "{0} · {1}", [value.product, uiTerm(context)]);
      if (!value.product) {
        const line = String(label).match(/^Line (\d+)(?: · (.*))?$/);
        if (line && (!line[2] || line[2] === context)) return line[2]
          ? uiNode("span", cls, "{0} · {1}", [uiTerm("Line {0}", [line[1]]), uiTerm(context)])
          : uiNode("span", cls, "Line {0}", [line[1]]);
      }
    }
    return node("span", cls, label);
  }
  function sourceGroups(container, definition, row) {
    if (Array.isArray(row.breakdown?.source_groups)) {
      for (const group of row.breakdown.source_groups) {
        if (["Summary", "Multipliers"].includes(group.label)) continue;
        const section = node("details", "penetration-output-group"); section.append(node("summary", "", group.label));
        if (!group.rows.length) section.append(uiNode("p", "helper", "No schedule items."));
        for (const item of group.rows) {
          section.append(node("h4", "penetration-source-line", item.label));
          const list = node("dl", "cost-list");
          for (const field of item.values.filter(field => !["B", "C", "D", "E", "BI", "BJ", "BK"].includes(field.column))) {
            const line = node("div"); line.append(node("dt", "", field.label + (field.units ? ` (${field.units})` : "")), node("dd", "", display(field.value, field.format))); list.append(line);
          }
          section.append(list);
        }
        container.append(section);
      }
      return;
    }
  }
  function render(definition, row, schedule = false) {
    const container = node("div", "penetration-breakdown-content");
    if (!row) { container.append(uiNode("p", "helper", schedule ? "Recalculate to see the schedule output." : "Recalculate to see this item's output.")); return container; }
    if (row.errors?.length) {
      const messages = row.errors.filter(error => !String(error.message).startsWith("#"))
        .map(error => String(error.message).replace(/#(?:VALUE!|REF!|NUM!|DIV\/0!|N\/A|NAME\?|NULL!|CALC!)/g, "an unavailable calculation value"));
      if (!messages.length) {
        const inputs = row.inputs || {}, required = [];
        if (!(inputs.O > 0)) required.push("Item QTY");
        if (!inputs.W) required.push("Teams/Crews");
        if (inputs.Y && !(inputs.AL > 0) && !(inputs.pipe_labour_hours > 0)) required.push("Diameter or Pipe Labour hours");
        if ((inputs.Y || inputs.AA) && !(inputs.AN > 0)) required.push("Multiplier");
        messages.push(required.length ? `Enter ${required.join(", ")}.` : "Check the item inputs and selected products, then recalculate.");
      }
      container.append(node("p", "message error", [...new Set(messages)].join("\n")));
    }
    const breakdown = row.breakdown;
    if (!breakdown || !Array.isArray(breakdown.rows)) { container.append(uiNode("p", "helper", "The item breakdown is unavailable.")); sourceGroups(container, definition, row); return container; }
    const scroll = node("div", "table-scroll penetration-breakdown-scroll"), table = node("table", "penetration-breakdown-table");
    const caption = schedule ? "Schedule cost breakdown" : "Item cost breakdown";
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); uiAttr(scroll, "aria-label", caption);
    table.append(uiNode("caption", "sr-only", caption));
    const head = node("thead"), headings = node("tr"), body = node("tbody"), foot = node("tfoot"), subtotal = node("tr");
    for (const label of ["Item", "Unit Prices", "Material Quantities", "Material Costs", "Labour Costs", "Task Hours"]) { const cell = uiNode("th", "", label); cell.setAttribute("scope", "col"); headings.append(cell); }
    head.append(headings);
    for (const item of breakdown.rows) {
      const line = node("tr"), label = taskLabels.has(item.label) ? uiNode("th", "", item.label) : node("th", "", item.label); label.setAttribute("scope", "row");
      line.append(label, details(item.unit_prices, "currency"), details(item.material_quantities, "number"));
      for (const [key, format] of [["material_costs", "currency"], ["labour_costs", "currency"], ["task_hours", "number"]]) line.append(displayNode("td", item[key], format));
      body.append(line);
    }
    const label = uiNode("th", "", "Subtotal"); label.setAttribute("scope", "row"); label.colSpan = 3; subtotal.append(label);
    for (const [key, format] of [["material_costs", "currency"], ["labour_costs", "currency"], ["task_hours", "number"]]) subtotal.append(displayNode("td", breakdown.totals?.[key], format));
    foot.append(subtotal); table.append(head, body, foot); scroll.append(table); container.append(scroll);
    if (breakdown.note && !schedule) container.append(node("p", "helper penetration-breakdown-note", breakdown.note));
    sourceGroups(container, definition, row);
    return container;
  }
  function renderSchedule(definition, result) {
    return render(definition, result ? { breakdown: result.schedule_breakdown, errors: result.errors, outputs: {} } : null, true);
  }
  window.CeasefirePenetrationBreakdown = { render, renderSchedule };
})();
