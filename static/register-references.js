"use strict";

// Reference navigation is a selection aid. It never approves a configuration
// or writes library assignments, calculator inputs or Takeoff state.
((root) => {
  const doc = options => options?.document || root.document;
  const text = value => value == null ? "" : String(value);
  function node(document, tag, value) { const element = document.createElement(tag); if (value !== undefined) element.textContent = text(value); return element; }
  function ui(element, source, args = []) { return root.CeasefireI18n?.nodeText ? root.CeasefireI18n.nodeText(element, source, args) : (element.textContent = source.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ""), element); }
  const caption = value => ["Manufacturer not recorded", "Assessment not identified in source"].includes(value) && root.CeasefireI18n?.translate ? root.CeasefireI18n.translate(value) : value;
  function publicURL(value) {
    if (typeof value !== "string" || !value || /[\s<>"\\\x00-\x1f\x7f]/.test(value)) return null;
    if (/^\/api\/libraries\/documents\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\.pdf$/.test(value)) return value;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : null; } catch (_) { return null; }
  }
  function renderReports(references, options = {}) {
    const document = doc(options), result = node(document, "span"); result.className = "register-report-references";
    let values = Array.isArray(references) ? references : [], page = options.pagination || {}, pending = false;
    function paint() {
      result.replaceChildren();
      for (const reference of values) {
        if (!reference || !text(reference.label).trim()) continue;
        if (result.children.length) result.append(node(document, "span", " | "));
        const url = publicURL(reference.url), item = node(document, url ? "a" : "span", caption(reference.label));
        if (url) { item.href = url; item.target = "_blank"; item.rel = "noopener noreferrer"; }
        result.append(item);
      }
      if (!result.children.length) result.textContent = "—";
      if (page.report_has_more && options.loadMore) {
        const more = ui(node(document, "button"), "More reports ({0} of {1})", [(page.report_offset || 0) + values.length, page.report_total]); more.type = "button"; more.className = "text-button";
        more.addEventListener("click", async () => {
          if (pending || options.isCurrent && !options.isCurrent()) return;
          pending = true; more.disabled = true;
          try {
            const next = await options.loadMore((page.report_offset || 0) + values.length);
            if (options.isCurrent && !options.isCurrent()) return;
            values = [...values, ...next.reports]; page = { ...next, report_offset: 0 }; pending = false; paint();
          } catch (error) { if (!options.isCurrent || options.isCurrent()) options.notify?.(error.message, true); }
          finally { pending = false; more.disabled = false; }
        });
        result.append(node(document, "br"), more);
      }
    }
    paint(); return result;
  }
  function renderSystems(reference, options = {}) {
    const document = doc(options), result = node(document, "span"); result.className = "register-system-references";
    let current = reference || {}, pending = false;
    function paint() {
      result.replaceChildren();
      const groups = new Map();
      for (const item of current.systems || []) {
        if (!item || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(item.id || "") || !Number.isSafeInteger(item.number) || item.number < 1) continue;
        const manufacturer = options.plainNumbers ? "" : text(item.manufacturer) || "Manufacturer not recorded";
        if (!groups.has(manufacturer)) groups.set(manufacturer, []); groups.get(manufacturer).push(item);
      }
      let sequence = current.offset || 0;
      for (const [manufacturer, systems] of groups) {
        if (result.children.length) result.append(node(document, "span", " | "));
        const group = node(document, "span"); if (!options.plainNumbers) group.append(node(document, "span", `${caption(manufacturer)}-`));
        for (const [index, item] of systems.entries()) {
          if (index) group.append(node(document, "span", options.plainNumbers ? " | " : ", "));
          const number = options.plainNumbers ? ++sequence : item.number;
          const control = node(document, "button", number); control.type = "button"; control.className = "text-button";
          control.dataset.technicalReference = item.id; control.title = item.title;
          control.setAttribute("aria-label", options.plainNumbers ? `${number}. ${item.title}` : `${caption(manufacturer)}: ${item.number}. ${item.title}`);
          control.addEventListener("click", async () => { if (options.isCurrent && !options.isCurrent()) return; try { await root.CeasefireLibraryNavigation?.open("technical", item.id); } catch (error) { options.notify?.(error.message, true); } });
          group.append(control);
        }
        result.append(group);
      }
      if (!result.children.length) result.textContent = "—";
      if (current.has_more && options.loadMore) {
        const more = ui(node(document, "button"), "More systems ({0} of {1})", [(current.offset || 0) + (current.systems || []).length, current.total]); more.type = "button"; more.className = "text-button"; more.disabled = pending;
        more.addEventListener("click", async () => {
          if (pending || options.isCurrent && !options.isCurrent()) return;
          pending = true; more.disabled = true;
          try {
            const next = await options.loadMore((current.offset || 0) + (current.systems || []).length);
            if (options.isCurrent && !options.isCurrent()) return;
            // All accumulated pages are rebuilt together, so each manufacturer
            // remains a single prefix and its native numbers stay intact.
            current = { ...next, offset: 0, systems: [...current.systems, ...next.systems] }; pending = false; paint();
          } catch (error) { if (!options.isCurrent || options.isCurrent()) options.notify?.(error.message, true); }
          finally { pending = false; more.disabled = false; }
        });
        result.append(node(document, "br"), more);
      }
    }
    paint(); return result;
  }
  const api = { renderReports, renderSystems, publicURL };
  root.CeasefireRegisterReferences = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" ? window : globalThis);
