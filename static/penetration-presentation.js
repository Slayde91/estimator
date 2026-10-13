"use strict";

// Labels and layout only. Workbook column keys and stored option values stay
// canonical so old projects and source calculations keep their identity.
(function (root) {
  const labels = Object.freeze({ K: "Services", L: "Type", M: "Orientation", X: "Board", Z: "Framing", AA: "Wrap", AB: "Mastic", Y: "Collars" });
  const serviceLabels = new Map([["Copper Pipes", "Unlagged Copper Pipes"], ["Steel Pipes", "Unlagged Steel Pipes"]]);
  const serviceLabel = value => serviceLabels.get(value) || value;
  const optionLabel = (field, value) => field.column === "K" ? serviceLabel(value) : value;
  const vertical = new Set(["Plasterboard wall", "Concrete/masonry wall", "Hebel wall", "Speedpanel wall", "Dincel wall", "AFS wall", "CLT wall", "Insulated panel wall"]);
  const horizontal = new Set(["Plasterboard ceiling", "Concrete/masonry floor", "Bondek floor", "Hebel floor", "CLT floor"]);
  const orientation = substrate => vertical.has(substrate) ? "Vertical" : horizontal.has(substrate) ? "Horizontal" : null;
  function serviceSize(inputs) {
    const present = value => value !== null && value !== undefined && value !== "";
    const sizes = [];
    if (present(inputs.AL)) sizes.push(`Ø ${inputs.AL}`);
    if (present(inputs.AQ) || present(inputs.AR)) sizes.push(`${present(inputs.AQ) ? inputs.AQ : "—"} × ${present(inputs.AR) ? inputs.AR : "—"}`);
    return sizes.join("; ") || "—";
  }
  function fieldGroups(fields) {
    const pairs = [["J", "K"], ["L", "N"], ["P", "M"], ["X", "AA"], ["AE", "AF"], ["AB", "AC"]], used = new Set(), groups = [];
    for (const field of fields) {
      if (used.has(field.column)) continue;
      const pair = pairs.find(pair => pair.includes(field.column) && pair.every(column => fields.some(value => value.column === column)));
      const group = pair ? pair.map(column => fields.find(value => value.column === column)) : [field];
      group.forEach(value => used.add(value.column)); groups.push(group);
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
  const api = Object.freeze({ labels, serviceLabel, optionLabel, orientation, serviceSize, fieldGroups, growTextarea });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefirePenetrationPresentation = api;
})(typeof window === "object" ? window : null);
