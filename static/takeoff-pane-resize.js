"use strict";

// Workspace presentation only. Resizing never changes the PDF's scale or geometry.
(() => {
  function limits(width) {
    const maximum = Math.max(0, Math.min(640, width - 132 - (width > 700 ? 240 : 0)));
    return { minimum: Math.min(220, maximum), maximum };
  }
  function bounded(value, width) {
    const { minimum, maximum } = limits(width);
    return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 300));
  }
  function bindSeparator(handle, currentWidth, resize, range, direction) {
    let drag = null;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || handle.hidden || drag) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, x: event.clientX, width: currentWidth(), direction: direction() };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      event.preventDefault(); resize(drag.width + (event.clientX - drag.x) * drag.direction);
    });
    const end = event => { if (drag?.id === event.pointerId) drag = null; };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, end);
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Home") resize(range().minimum);
      else if (event.key === "End") resize(range().maximum);
      else resize(currentWidth() + (event.key === "ArrowLeft" ? -1 : 1) * direction() * (event.shiftKey ? 40 : 10));
    });
  }
  function updateRange(handle, range, width) {
    for (const [name, value] of Object.entries({ min: range.minimum, max: range.maximum, now: width })) {
      handle.setAttribute(`aria-value${name}`, String(Math.round(value)));
    }
  }
  function mount(layout, panels) {
    let width = 300;
    const handle = document.createElement("div");
    handle.className = "takeoff-pane-resizer"; handle.tabIndex = 0;
    handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize settings pane");
    handle.title = "Drag to resize settings; use arrow keys when focused";
    layout.append(handle);
    const refresh = () => {
      const rect = layout.getBoundingClientRect(), range = limits(rect.width);
      width = bounded(width, rect.width); layout.style.setProperty("--takeoff-pane-width", `${width}px`);
      const panel = panels.find(value => !value.hidden);
      handle.hidden = !panel || !range.maximum;
      if (panel) {
        const box = panel.getBoundingClientRect();
        handle.style.left = `${box.right - rect.left - 4}px`;
        handle.style.top = `${box.top - rect.top}px`; handle.style.height = `${box.height}px`;
      }
      updateRange(handle, range, width);
    };
    bindSeparator(handle, () => width, value => { width = bounded(value, layout.clientWidth); refresh(); }, () => limits(layout.clientWidth), () => 1);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
    observer?.observe(layout); panels.forEach(panel => observer?.observe(panel));
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(refresh) : null;
    panels.forEach(panel => mutation?.observe(panel, { attributes: true, attributeFilter: ["hidden"] }));
    refresh();
    return { refresh, destroy: () => { observer?.disconnect(); mutation?.disconnect(); handle.remove(); } };
  }
  function mountRegister(workspace, pane) {
    let fraction = 0.45;
    const handle = document.createElement("div");
    handle.className = "takeoff-register-resizer"; handle.tabIndex = 0;
    handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-controls", pane.id);
    for (const attribute of ["title", "aria-label"]) window.CeasefireI18n.attr(handle, attribute, "Resize register");
    pane.before(handle);
    const range = () => {
      const available = workspace.clientWidth;
      return { minimum: 350, maximum: Math.max(350, Math.min(available * 0.70, available - 380)) };
    };
    const clamp = (value, { minimum, maximum }) => Math.max(minimum, Math.min(maximum, value));
    const refresh = () => {
      if (!workspace.clientWidth || getComputedStyle(workspace).flexDirection !== "row") return;
      const bounds = range(), width = clamp(fraction * workspace.clientWidth, bounds);
      pane.style.setProperty("--takeoff-register-width", `${width}px`);
      updateRange(handle, bounds, width);
    };
    bindSeparator(handle, () => pane.getBoundingClientRect().width, value => {
      if (!workspace.clientWidth) return;
      fraction = clamp(value, range()) / workspace.clientWidth; refresh();
    }, range, () => getComputedStyle(workspace).direction === "rtl" ? 1 : -1);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
    observer?.observe(workspace); refresh();
    return { refresh, destroy: () => { observer?.disconnect(); handle.remove(); } };
  }
  window.CeasefireTakeoffPaneResize = { mount, mountRegister, bounded, limits };
})();
