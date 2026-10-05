"use strict";

// Use punctuation/function keys so native editing, Save, browser navigation,
// printing and numbered-tab shortcuts keep their established meanings.
(function (root) {
  const actions = Object.freeze({
    select: Object.freeze({ key: ";", label: "Select" }),
    pan: Object.freeze({ key: "[", label: "Pan" }),
    settings: Object.freeze({ key: "]", label: "Settings" }),
    viewport: Object.freeze({ key: "\\", label: "Viewport" }),
    calibrate: Object.freeze({ key: "F1", label: "Calibrate" }),
    trace: Object.freeze({ key: "F2", label: "Trace length" }),
    count: Object.freeze({ key: "F3", label: "Count" }),
    countLength: Object.freeze({ key: "F7", label: "Count steel lengths" }),
    polygon: Object.freeze({ key: "F8", label: "Trace surface" }),
    exclusion: Object.freeze({ key: "F9", label: "Add exclusion" }),
    measure: Object.freeze({ key: "F10", label: "Length" }),
    markups: Object.freeze({ key: ",", label: "Markups" }),
    legend: Object.freeze({ key: ".", label: "Legend" }),
    visibility: Object.freeze({ key: "/", label: "Visibility" }),
    callout: Object.freeze({ key: "'", label: "Call-out" }),
  });
  function decorate(control, action, label = actions[action]?.label) {
    const definition = actions[action]; if (!control || !definition) return;
    control.title = `${label} (Ctrl+${definition.key})`;
    control.setAttribute("aria-keyshortcuts", `Control+${definition.key}`);
    control.dataset.shortcutAction = action;
  }
  function isEditable(target) {
    return !!target?.isContentEditable || !!target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]");
  }
  function available(control) {
    return !!control && !control.disabled && !control.hidden && !control.matches?.(":disabled") && !control.closest?.("[hidden], [inert]");
  }
  function dispatch(event, controls, blocked = false) {
    if (blocked || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditable(event.target)) return false;
    const action = Object.keys(actions).find(name => actions[name].key.toLowerCase() === String(event.key).toLowerCase());
    if (!action) return false;
    const control = controls[action]; if (!available(control)) return false;
    event.preventDefault(); event.stopPropagation(); control.click(); return true;
  }
  const api = Object.freeze({ actions, decorate, dispatch, isEditable, available });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffShortcuts = api;
})(typeof window === "object" ? window : null);
