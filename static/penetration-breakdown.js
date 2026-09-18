(() => {
  "use strict";
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const percent = new Intl.NumberFormat("en-AU", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const node = (tag, className = "", text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
  function display(value, format) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
    return format === "currency" ? currency.format(value) : format === "percent" ? percent.format(value) : number.format(value);
  }
  function details(values, format) {
    const cell = node("td");
    if (!Array.isArray(values) || !values.length) { cell.textContent = "—"; return cell; }
    for (const value of values) {
      const entry = node("div", "penetration-breakdown-value");
      if (value.label) entry.append(node("span", "penetration-breakdown-context", value.label));
      entry.append(node("span", "", `${display(value.value, value.format || format)}${value.units ? ` ${value.units}` : ""}`)); cell.append(entry);
    }
    return cell;
  }
  function sourceGroups(container, definition, row) {
    for (const group of ["Summary", "Multipliers"]) {
      const fields = (definition?.output_fields || []).filter(field => field.group === group);
      if (!fields.length) continue;
      const section = node("details", "penetration-output-group"), list = node("dl", "cost-list");
      section.append(node("summary", "", group));
      for (const field of fields) {
        const line = node("div"); line.append(node("dt", "", field.label + (field.units ? ` (${field.units})` : "")), node("dd", "", display(row.outputs?.[field.column], field.format))); list.append(line);
      }
      section.append(list); container.append(section);
    }
  }
  function render(definition, row) {
    const container = node("div", "penetration-breakdown-content");
    if (!row) { container.append(node("p", "helper", "Recalculate to see this item's output.")); return container; }
    if (row.errors?.length) container.append(node("p", "message error", row.errors.map(error => `${error.cell}: ${error.message}`).join("\n")));
    const breakdown = row.breakdown;
    if (!breakdown || !Array.isArray(breakdown.rows)) { container.append(node("p", "helper", "The item breakdown is unavailable.")); sourceGroups(container, definition, row); return container; }
    const scroll = node("div", "table-scroll penetration-breakdown-scroll"), table = node("table", "penetration-breakdown-table");
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Item cost breakdown");
    table.append(node("caption", "sr-only", "Item cost breakdown"));
    const head = node("thead"), headings = node("tr"), body = node("tbody"), foot = node("tfoot"), subtotal = node("tr");
    for (const label of ["Item", "Unit Prices", "Material Quantities", "Material Costs", "Labour Costs", "Task Hours"]) { const cell = node("th", "", label); cell.setAttribute("scope", "col"); headings.append(cell); }
    head.append(headings);
    for (const item of breakdown.rows) {
      const line = node("tr"), label = node("th", "", item.label); label.setAttribute("scope", "row");
      line.append(label, details(item.unit_prices, "currency"), details(item.material_quantities, "number"));
      for (const [key, format] of [["material_costs", "currency"], ["labour_costs", "currency"], ["task_hours", "number"]]) line.append(node("td", "", display(item[key], format)));
      body.append(line);
    }
    const label = node("th", "", "Subtotal"); label.setAttribute("scope", "row"); label.colSpan = 3; subtotal.append(label);
    for (const [key, format] of [["material_costs", "currency"], ["labour_costs", "currency"], ["task_hours", "number"]]) subtotal.append(node("td", "", display(breakdown.totals?.[key], format)));
    foot.append(subtotal); table.append(head, body, foot); scroll.append(table); container.append(scroll);
    if (breakdown.note) container.append(node("p", "helper penetration-breakdown-note", breakdown.note));
    sourceGroups(container, definition, row);
    return container;
  }
  window.CeasefirePenetrationBreakdown = { render };
})();
