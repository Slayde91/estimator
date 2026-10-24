"use strict";

// Labels and layout only. Workbook column keys and stored option values stay
// canonical so old projects and source calculations keep their identity.
(function (root) {
  const labels = Object.freeze({ K: "Services", L: "Type", M: "Orientation", X: "Board", Z: "Framing", AA: "Wrap", AB: "Mastic", Y: "Collars" });
  const serviceLabels = new Map([["Copper Pipes", "Unlagged Copper Pipes"], ["Steel Pipes", "Unlagged Steel Pipes"], ["Junction Box", "Conduits"]]);
  const categoryOnly = new Set(["Access Panel", "Blank Seal", "Linear Joints", "Movement Joints", "Structural Steel", "Structural Timber"]);
  const key = value => String(value ?? "").trim().toLowerCase();
  const moved = new Map([...categoryOnly].map(value => [key(value), value]));
  const categories = new Map(["Electrical & Communications", "Mechanical", "HVAC", "Plumbing & Hydraulic", "Structural Steel", "Access Panel", "Blank Seal", "Bulkheads", "Linear Joints", "Movement Joints", "Structural Timber"].map(value => [key(value), value]));
  const openingTypes = ["Core hole", "Oversized core hole"];
  const openingType = value => ({ "core hole": openingTypes[0], oversized: openingTypes[1], "oversized core hole": openingTypes[1] })[String(value ?? "").trim().toLowerCase()] || value;
  const serviceLabel = value => serviceLabels.get(value) || value;
  const optionLabel = (field, value) => field.column === "K" ? serviceLabel(value) : field.column === "L" ? openingType(value) : value;
  function details(inputs) {
    const result = { ...inputs };
    result.J = categories.get(key(inputs.J)) || String(inputs.J ?? "").trim();
    if (moved.has(key(inputs.K))) { result.J = moved.get(key(inputs.K)); result.K = "N/A"; }
    else if (!key(inputs.K) && categoryOnly.has(result.J)) result.K = "N/A";
    else if (["junction box", "conduit", "conduits"].includes(key(inputs.K))) result.K = "Conduits";
    else result.K = key(inputs.K) === "n/a" ? "N/A" : String(inputs.K ?? "").trim();
    result.L = openingType(inputs.L); return result;
  }
  function choiceOptions(field, configured) {
    if (field.column === "L") return [...openingTypes];
    const values = configured ?? field.options ?? [];
    if (field.column === "J") return [...new Set([...(field.options || []), ...values])];
    if (field.column === "K") return [...new Set(["N/A", ...values.filter(value => !moved.has(key(value))).map(value => ["junction box", "conduit", "conduits"].includes(key(value)) ? "Conduits" : key(value) === "n/a" ? "N/A" : value)])];
    return values;
  }
  const vertical = new Set(["Plasterboard wall", "Concrete/masonry wall", "Hebel wall", "Speedpanel wall", "Dincel wall", "AFS wall", "CLT wall", "Insulated panel wall"]);
  const horizontal = new Set(["Plasterboard ceiling", "Concrete/masonry floor", "Bondek floor", "Hebel floor", "CLT floor"]);
  const orientation = substrate => vertical.has(substrate) ? "Vertical" : horizontal.has(substrate) ? "Horizontal" : null;
  function serviceSize(inputs, source) {
    const present = value => value !== null && value !== undefined && value !== "";
    const sizes = [];
    if (present(inputs.AL)) sizes.push(`Ø ${inputs.AL}`);
    if (present(inputs.AQ) || present(inputs.AR)) sizes.push(`${present(inputs.AQ) ? inputs.AQ : "—"} × ${present(inputs.AR) ? inputs.AR : "—"}`);
    return sizes.join("; ") || source?.service_size || "—";
  }
  function fieldGroups(fields) {
    const pairs = [["J", "K"], ["L", "N"], ["P", "M"], ["X", "AA"], ["AE", "AF"], ["AB", "AC"]], used = new Set(), groups = [];
    for (const field of fields) {
      if (used.has(field.column)) continue;
      const pair = pairs.find(pair => pair.includes(field.column) && pair.every(column => fields.some(value => value.column === column)));
      const group = pair ? pair.map(column => fields.find(value => value.column === column)) : [field];
      group.forEach(value => used.add(value.column)); groups.push(group);
    }
    // Keep the source columns intact while placing complete visual groups.
    const collar = groups.findIndex(group => group.some(field => field.column === "Y"));
    const mastic = groups.findIndex(group => group.some(field => field.column === "AB"));
    if (collar >= 0 && mastic >= 0) [groups[collar], groups[mastic]] = [groups[mastic], groups[collar]];
    if (fields.some(field => field.group === "Additional Allowances")) {
      const order = new Map(["AE", "AF", "AI", "AH", "AJ"].map((column, index) => [column, index]));
      groups.sort((left, right) => (order.get(left[0].column) ?? 100) - (order.get(right[0].column) ?? 100));
    }
    return groups;
  }
  function growTextarea(control) {
    control.rows = 1;
    const grow = () => {
      if (!control.isConnected || !control.clientHeight) return;
      // Grow to the content; never undo a user's manual vertical resize.
      if (control.scrollHeight > control.clientHeight) control.style.height = `${control.scrollHeight + control.offsetHeight - control.clientHeight}px`;
    };
    control.addEventListener("input", grow);
    root?.requestAnimationFrame?.(grow);
  }
  const api = Object.freeze({ labels, serviceLabel, optionLabel, openingType, details, choiceOptions, orientation, serviceSize, fieldGroups, growTextarea });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefirePenetrationPresentation = api;
})(typeof window === "object" ? window : null);
