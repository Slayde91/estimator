"use strict";

// Tool shortcuts are scoped to the drawing workspace; native editing is never
// intercepted. Modifiers are exact so old bindings cannot remain as aliases.
(function (root) {
  const actions = Object.freeze({
    select: Object.freeze({ key: "H", label: "Select" }),
    pan: Object.freeze({ key: "H", shift: true, label: "Pan" }),
    text: Object.freeze({ key: "T", shift: true, label: "Select PDF text" }),
    settings: Object.freeze({ key: "S", shift: true, label: "Settings" }),
    viewport: Object.freeze({ key: "V", shift: true, label: "Viewport" }),
    trace: Object.freeze({ key: "L", shift: true, label: "Trace length" }),
    count: Object.freeze({ key: "C", shift: true, label: "Count" }),
    polygon: Object.freeze({ key: "A", shift: true, label: "Trace surface" }),
    exclusion: Object.freeze({ key: "E", shift: true, label: "Add exclusion" }),
    measure: Object.freeze({ key: "M", label: "Measure" }),
    visibility: Object.freeze({ key: "V", ctrl: true, shift: true, label: "Visibility" }),
    callout: Object.freeze({ key: "Q", label: "Call-out" }),
    signature: Object.freeze({ key: "S", ctrl: true, shift: true, label: "Signatures" }),
    "graphic-cloud": Object.freeze({ key: "C", label: "Cloud" }),
    "graphic-stamp": Object.freeze({ key: "S", label: "Stamp" }),
    "graphic-polyline": Object.freeze({ key: "L", label: "Line / Polyline" }),
    "graphic-arrow": Object.freeze({ key: "A", label: "Arrow" }),
    "graphic-rectangle": Object.freeze({ key: "R", label: "Rectangle" }),
    "graphic-circle": Object.freeze({ key: "E", label: "Circle" }),
    "graphic-polygon": Object.freeze({ key: "P", label: "Polygon" }),
  });
  const viewerActions = Object.freeze({
    rotateLeft: Object.freeze({ key: "ArrowUp", label: "Rotate page left" }),
    rotateRight: Object.freeze({ key: "ArrowDown", label: "Rotate page right" }),
    previousPage: Object.freeze({ key: "ArrowLeft", label: "Previous page" }),
    nextPage: Object.freeze({ key: "ArrowRight", label: "Next page" }),
    zoomOut: Object.freeze({ key: "-", label: "Zoom out" }),
    zoomIn: Object.freeze({ key: "+", label: "Zoom in" }),
  });
  function shortcut(definition, accessible = false) {
    return [definition.ctrl ? accessible ? "Control" : "Ctrl" : null, definition.shift ? "Shift" : null, definition.key].filter(Boolean).join("+");
  }
  function decorate(control, action, label = actions[action]?.label) {
    const definition = actions[action]; if (!control || !definition) return;
    control.title = `${label} (${shortcut(definition)})`;
    control.setAttribute("aria-keyshortcuts", shortcut(definition, true));
    control.dataset.shortcutAction = action;
  }
  function isEditable(target) {
    return !!target?.isContentEditable || !!target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]");
  }
  function available(control) {
    return !!control && !control.disabled && !control.hidden && !control.matches?.(":disabled") && !control.closest?.("[hidden], [inert]");
  }
  function dispatch(event, controls, blocked = false) {
    if (blocked || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.metaKey || event.altKey || isEditable(event.target)) return false;
    const action = Object.keys(actions).find(name => actions[name].key.toLowerCase() === String(event.key).toLowerCase() && !!actions[name].ctrl === !!event.ctrlKey && !!actions[name].shift === !!event.shiftKey);
    if (!action) return false;
    const control = controls[action]; if (!available(control)) return false;
    event.preventDefault(); event.stopPropagation(); control.click(); return true;
  }
  function dispatchViewer(event, callbacks, blocked = false) {
    if (blocked || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return false;
    const key = String(event.key), plus = key === "+" || key === "=";
    if (event.shiftKey && !plus) return false;
    const action = plus ? "zoomIn" : Object.keys(viewerActions).find(name => viewerActions[name].key === key);
    const callback = callbacks[action]; if (!action || typeof callback !== "function") return false;
    event.preventDefault(); event.stopPropagation(); callback(); return true;
  }
  const api = Object.freeze({ actions, viewerActions, shortcut, decorate, dispatch, dispatchViewer, isEditable, available });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffShortcuts = api;
})(typeof window === "object" ? window : null);
