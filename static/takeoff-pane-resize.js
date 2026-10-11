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
  function mount(layout, panels) {
    let width = 300, drag = null;
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
      for (const [name, value] of Object.entries({ min: range.minimum, max: range.maximum, now: width })) handle.setAttribute(`aria-value${name}`, String(Math.round(value)));
    };
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || handle.hidden) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, x: event.clientX, width }; handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault(); width = bounded(drag.width + event.clientX - drag.x, layout.getBoundingClientRect().width); refresh();
    });
    const end = event => { if (drag?.id === event.pointerId) { drag = null; refresh(); } };
    handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end); handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const range = limits(layout.getBoundingClientRect().width);
      width = event.key === "Home" ? range.minimum : event.key === "End" ? range.maximum : width + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10);
      refresh();
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
    observer?.observe(layout); panels.forEach(panel => observer?.observe(panel));
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(refresh) : null;
    panels.forEach(panel => mutation?.observe(panel, { attributes: true, attributeFilter: ["hidden"] }));
    refresh();
    return { refresh, destroy: () => { observer?.disconnect(); mutation?.disconnect(); handle.remove(); } };
  }
  window.CeasefireTakeoffPaneResize = { mount, bounded, limits };
})();
