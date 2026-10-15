"use strict";

// Main-panel geometry only. No quote fields, calculations or project storage.
(function (root) {
  const bounds = (available, minimumSummary, minimumForm = 300) => ({
    minimum: minimumSummary,
    maximum: Math.max(minimumSummary, available - minimumForm),
    stacked: available < minimumSummary + minimumForm,
  });
  function mount(document) {
    const divider = document.getElementById("main-summary-divider"), form = document.getElementById("main-estimate-form"), summary = document.getElementById("main-estimate-summary");
    const layout = divider?.parentElement;
    if (!layout || !form || !summary || divider.dataset.layoutReady) return null;
    divider.dataset.layoutReady = "true"; layout.classList.add("main-layout-ready");
    let preferred = null, range, drag = null, frame = null, destroyed = false;
    const number = value => Number.parseFloat(value) || 0;
    const width = element => {
      if (!element) return 0;
      const text = document.createRange(); text.selectNodeContents(element);
      return text.getBoundingClientRect().width;
    };
    function minimumWidth() {
      const style = root.getComputedStyle(summary), padding = number(style.paddingLeft) + number(style.paddingRight) + number(style.borderLeftWidth) + number(style.borderRightWidth);
      const values = [...summary.querySelectorAll(".cost-list dd,.metrics dd")].map(width);
      const metrics = summary.querySelector(".metrics"), metricGap = metrics ? number(root.getComputedStyle(metrics).columnGap) : 0;
      const metricWidths = [...(metrics?.children || [])].map(column => Math.max(width(column.querySelector("dt")), width(column.querySelector("dd"))));
      const metricsWidth = metricWidths.reduce((total, value) => total + value, 0) + Math.max(0, metricWidths.length - 1) * metricGap;
      const total = summary.querySelector(".grand-total"), totalStyle = total && root.getComputedStyle(total);
      const totalPadding = totalStyle ? number(totalStyle.paddingLeft) + number(totalStyle.paddingRight) : 0;
      return Math.ceil(Math.max(290, padding + Math.max(0, ...values) + 125, padding + metricsWidth + 8, padding + totalPadding + width(total?.querySelector("strong")) + 8));
    }
    function update() {
      frame = null;
      if (destroyed || !layout.isConnected || !layout.clientWidth) return;
      const layoutStyle = root.getComputedStyle(layout), gutter = number(layoutStyle.columnGap) * 2 + 12;
      const available = Math.max(0, layout.clientWidth - gutter), minimum = minimumWidth();
      range = bounds(available, minimum);
      layout.classList.toggle("main-summary-stacked", range.stacked || root.innerWidth <= 880);
      divider.hidden = layout.classList.contains("main-summary-stacked");
      const desired = preferred === null ? Math.max(330, minimum) : available * preferred;
      const chosen = Math.max(range.minimum, Math.min(range.maximum, desired));
      layout.style.setProperty("--main-summary-width", `${chosen}px`);
      const header = document.querySelector(".app-header");
      if (header) layout.style.setProperty("--main-summary-sticky-top", `${Math.ceil(header.getBoundingClientRect().height + 16)}px`);
      const percent = value => available ? Math.round(value / available * 100) : 0;
      divider.setAttribute("aria-valuemin", String(percent(range.minimum)));
      divider.setAttribute("aria-valuemax", String(percent(range.maximum)));
      divider.setAttribute("aria-valuenow", String(percent(chosen)));
      divider.setAttribute("aria-valuetext", `Estimate Summary ${Math.round(chosen)} pixels wide`);
      divider.dataset.available = String(available); divider.dataset.current = String(chosen);
    }
    function schedule() { if (!destroyed && frame === null) frame = root.requestAnimationFrame(update); }
    function resize(value) {
      const available = Number(divider.dataset.available);
      if (!range || !available || divider.hidden || !Number.isFinite(value)) return;
      preferred = Math.max(range.minimum, Math.min(range.maximum, value)) / available; update();
    }
    function finish(cancel = false) {
      if (!drag) return;
      if (cancel) preferred = drag.preferred;
      const pointer = drag.pointer; drag = null; layout.classList.remove("main-summary-dragging");
      if (divider.hasPointerCapture?.(pointer)) divider.releasePointerCapture(pointer);
      schedule();
    }
    divider.addEventListener("pointerdown", event => {
      if (event.button !== 0 || divider.hidden) return;
      event.preventDefault(); divider.focus(); drag = { pointer: event.pointerId, x: event.clientX, width: Number(divider.dataset.current), preferred };
      divider.setPointerCapture(event.pointerId); layout.classList.add("main-summary-dragging");
    });
    divider.addEventListener("pointermove", event => { if (drag?.pointer === event.pointerId) resize(drag.width - (event.clientX - drag.x)); });
    divider.addEventListener("pointerup", () => finish()); divider.addEventListener("pointercancel", () => finish(true));
    divider.addEventListener("lostpointercapture", () => finish());
    divider.addEventListener("keydown", event => {
      if (event.key === "Escape" && drag) { event.preventDefault(); finish(true); return; }
      const step = event.shiftKey ? 40 : 10, current = Number(divider.dataset.current);
      const target = event.key === "ArrowLeft" ? current + step : event.key === "ArrowRight" ? current - step : event.key === "Home" ? range?.minimum : event.key === "End" ? range?.maximum : null;
      if (target !== null && target !== undefined) { event.preventDefault(); resize(target); }
    });
    root.addEventListener("blur", () => finish(true)); root.addEventListener("resize", schedule);
    const observer = new root.ResizeObserver(schedule); observer.observe(layout); observer.observe(summary);
    const header = document.querySelector(".app-header"); if (header) observer.observe(header);
    const changes = new root.MutationObserver(schedule); changes.observe(summary, { childList: true, characterData: true, subtree: true });
    document.fonts?.ready?.then(schedule); document.fonts?.addEventListener?.("loadingdone", schedule);
    schedule();
    return { refresh: schedule, destroy() { destroyed = true; observer.disconnect(); changes.disconnect(); if (frame !== null) root.cancelAnimationFrame(frame); } };
  }
  const api = { mount, bounds };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) {
    root.CeasefireMainLayout = api;
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", () => mount(root.document), { once: true });
    else mount(root.document);
  }
})(typeof window === "object" ? window : null);
