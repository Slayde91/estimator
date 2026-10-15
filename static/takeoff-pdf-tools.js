"use strict";

// Page tools prepare new source bytes. Neither this dialog nor its helpers edit
// an existing document, markup, calibration, register item or calculator draft.
(function (root) {
  const names = { merge: "Merge PDF Files", organise: "Organise Pages", extract: "Extract Pages" };
  let active = null, pending = false;
  function pageCount(value) {
    if (!Number.isInteger(value) || value < 1 || value > 2000) throw new Error("Choose a PDF with 1 to 2,000 pages.");
    return value;
  }
  function parsePages(text, maximum) {
    pageCount(maximum);
    if (typeof text !== "string" || !text.trim() || text.length > 20000) throw new Error("Enter page numbers or ranges, such as 1, 3-5.");
    const result = [], seen = new Set();
    for (const token of text.split(",")) {
      const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) throw new Error("Use comma-separated page numbers or ranges, such as 1, 3-5.");
      const first = Number(match[1]), last = Number(match[2] || match[1]);
      if (![first, last].every(value => Number.isSafeInteger(value) && value >= 1 && value <= maximum)) throw new Error(`Page numbers must be between 1 and ${maximum}.`);
      const step = last >= first ? 1 : -1;
      for (let value = first; ; value += step) {
        if (seen.has(value)) throw new Error(`Page ${value} appears more than once. Choose each page once.`);
        seen.add(value); result.push(value);
        if (result.length > 2000) throw new Error("A new PDF supports at most 2,000 pages.");
        if (value === last) break;
      }
    }
    return result;
  }
  function formatPages(values) {
    const result = [];
    for (let index = 0; index < values.length; ++index) {
      const first = values[index]; let last = first;
      while (index+1 < values.length && values[index+1] === last+1) last = values[++index];
      result.push(first === last ? String(first) : `${first}-${last}`);
    }
    return result.join(", ");
  }
  function request(operation, identifiers, order, revision, documents) {
    if (!Object.hasOwn(names, operation) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Reopen PDF Tools from the current Takeoffs draft.");
    if (!Array.isArray(documents) || !Array.isArray(identifiers) || !identifiers.length || new Set(identifiers).size !== identifiers.length || identifiers.some(value => typeof value !== "string")) throw new Error("Choose distinct retained Source Documents.");
    const sources = new Map(documents.map(value => [value.id, value]));
    if (identifiers.some(value => !sources.has(value))) throw new Error("A selected Source Document is no longer available.");
    const selected = identifiers.map(value => sources.get(value)); selected.forEach(value => {
      pageCount(value.pages?.length);
      if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > 250*1024*1024) throw new Error("A selected Source Document has invalid retained PDF metadata.");
    });
    if (selected.reduce((sum, value) => sum + value.size, 0) > 250*1024*1024) throw new Error("The selected PDFs exceed the combined 250 MiB limit.");
    const body = { expected_revision: revision, operation, document_ids: [...identifiers] };
    if (operation === "merge") {
      if (selected.length < 2) throw new Error("Choose at least two Source Documents to merge.");
      if (selected.reduce((sum, value) => sum + value.pages.length, 0) > 2000) throw new Error("The merged PDF supports at most 2,000 pages.");
    } else {
      if (selected.length !== 1 || !Array.isArray(order) || !order.length || new Set(order).size !== order.length || order.some(value => !Number.isInteger(value) || value < 1 || value > selected[0].pages.length)) throw new Error("Choose distinct existing pages in the required order. Keep at least one page.");
      body.page_order = [...order];
    }
    return body;
  }
  async function checkedResult(value, operation) {
    const blob = value instanceof root.Blob ? value : value?.blob;
    if (!(blob instanceof root.Blob) || !blob.size || blob.size > 250*1024*1024 || blob.type !== "application/pdf") throw new Error("The page operation did not return a bounded PDF.");
    if (await blob.slice(0, 5).text() !== "%PDF-") throw new Error("The page operation did not return valid PDF bytes.");
    return { blob, filename: `CEASEFIRE-${{merge:"Merged-PDF",organise:"Organised-Pages",extract:"Extracted-Pages"}[operation]}.pdf` };
  }
  async function open(options) {
    if (!root?.document || active) throw new Error("Finish the open PDF Tools dialog first.");
    const { operation, documents, expectedRevision, requestPDF, onResult } = options || {};
    if (!Object.hasOwn(names, operation) || !Array.isArray(documents) || typeof requestPDF !== "function") throw new Error("PDF Tools require the current retained Source Documents.");
    if (!documents.length) throw new Error("Upload a Source Document before using PDF Tools.");
    if (operation === "merge" && documents.length < 2) throw new Error("Upload at least two Source Documents to merge PDFs.");
    const doc = root.document, dialog = doc.createElement("dialog"); dialog.className = "modal takeoff-pdf-tools-dialog";
    const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
    const uiNode = (tag, className, source, args = []) => root.CeasefireI18n.nodeText(node(tag, className), source, args);
    const uiMake = (label, ...args) => { const control = make(label, ...args); control.textContent = ""; return root.CeasefireI18n.nodeText(control, label); };
    const title = uiNode("h2", "", names[operation]); title.id = "takeoff-pdf-tools-title"; dialog.setAttribute("aria-labelledby", title.id);
    const intro = uiNode("p", "helper", "Prepare a new PDF. Original Source Documents and their existing markups stay attached to the original pages.");
    const status = node("p", "takeoff-pdf-tools-status"); status.setAttribute("role", "status");
    const workspace = node("div", "takeoff-pdf-tools-workspace"), output = node("label", "field"), outputSelect = node("select");
    window.CeasefireI18n.attr(outputSelect, "aria-label", "New PDF output"); output.append(uiNode("span", "", "New PDF output"), outputSelect);
    for (const [value, label] of [["download", "Download new PDF"], ["add-source", "Add as new Source Document"]]) {
      if (operation === "organise" && value === "add-source") continue;
      const option = uiNode("option", "", label); option.value = value; option.disabled = value === "add-source" && typeof onResult !== "function"; outputSelect.append(option);
    }
    outputSelect.value = operation !== "organise" && options.defaultAction === "add-source" && typeof onResult === "function" ? "add-source" : "download";
    outputSelect.disabled = operation === "organise";
    const summary = node("p", "helper takeoff-pdf-tools-summary"), controls = node("div", "actions");
    let sourceId = options.initialDocumentId && documents.some(value => value.id === options.initialDocumentId) ? options.initialDocumentId : documents[0].id;
    let order = [], mergeOrder = documents.map(value => value.id), included = new Set(mergeOrder), previewOffset = 0, prepared = null, result = null;
    const make = (label, fn, primary = false) => { const button = node("button", "button " + (primary ? "primary" : "secondary"), label); button.type = "button"; button.addEventListener("click", fn); return button; };
    const invalidate = () => { prepared = null; status.textContent = ""; };
    const source = () => documents.find(value => value.id === sourceId);
    function payload() { return request(operation, operation === "merge" ? mergeOrder.filter(value => included.has(value)) : [sourceId], order, expectedRevision, documents); }
    function describe() {
      try { const body = payload(); const pages = operation === "merge" ? body.document_ids.reduce((sum, id) => sum + documents.find(value => value.id === id).pages.length, 0) : order.length;
        root.CeasefireI18n.text(summary, pages === 1 ? "{0} page in the new PDF{1}." : "{0} pages in the new PDF{1}.", [pages, operation === "organise" ? root.CeasefireI18n.term("; {0} removed", [source().pages.length-order.length]) : ""]);
        create.disabled = false;
      } catch (error) { summary.textContent = error.message; create.disabled = true; }
    }
    function error(value) { status.textContent = value.message || String(value); }
    const rows = node("ol", "takeoff-pdf-tools-order"); window.CeasefireI18n.attr(rows, "aria-label", operation === "merge" ? "Source Document order" : "Output page order");
    const previous = uiMake("Previous pages", () => { previewOffset = Math.max(0, previewOffset-100); renderPages(); });
    const next = uiMake("Next pages", () => { previewOffset += 100; renderPages(); });
    const pagination = node("div", "takeoff-pdf-tools-pagination"); pagination.append(previous, next);
    function renderMerge() {
      rows.replaceChildren();
      for (const [index, id] of mergeOrder.entries()) {
        const source = documents.find(value => value.id === id), row = node("li"), label = node("label"), check = node("input"); check.type = "checkbox"; check.checked = included.has(id);
        label.append(check, doc.createTextNode(`${source.name} (${source.pages.length} pages)`));
        check.addEventListener("change", () => { check.checked ? included.add(id) : included.delete(id); invalidate(); describe(); });
        const up = make("↑", () => moveMerge(index, -1)), down = make("↓", () => moveMerge(index, 1)); window.CeasefireI18n.attr(up, "aria-label", "Move {0} up", [source.name]); window.CeasefireI18n.attr(down, "aria-label", "Move {0} down", [source.name]); up.disabled = index === 0; down.disabled = index === mergeOrder.length-1;
        const actions = node("div", "takeoff-pdf-tools-row-actions"); actions.append(up, down); row.append(label, actions); rows.append(row);
      }
      describe();
    }
    function moveMerge(index, delta) { [mergeOrder[index], mergeOrder[index+delta]] = [mergeOrder[index+delta], mergeOrder[index]]; invalidate(); renderMerge(); }
    const orderText = node("input"); orderText.type = "text"; orderText.maxLength = 20000; window.CeasefireI18n.attr(orderText, "aria-label", operation === "extract" ? "Pages to extract" : "Page order"); orderText.placeholder = "1, 3-5";
    function renderPages() {
      if (previewOffset >= order.length) previewOffset = Math.max(0, Math.floor((order.length-1)/100)*100);
      rows.replaceChildren(); orderText.value = formatPages(order);
      order.slice(previewOffset, previewOffset+100).forEach((number, local) => {
        const index = previewOffset+local, row = node("li"), actions = node("div", "takeoff-pdf-tools-row-actions"); row.append(uiNode("span", "", "Page {0}", [number]));
        const up = make("↑", () => movePage(index, -1)), down = make("↓", () => movePage(index, 1)); window.CeasefireI18n.attr(up, "aria-label", "Move page {0} up", [number]); window.CeasefireI18n.attr(down, "aria-label", "Move page {0} down", [number]); up.disabled = index === 0; down.disabled = index === order.length-1;
        const remove = uiMake("Remove", () => { order.splice(index,1); invalidate(); renderPages(); }); window.CeasefireI18n.attr(remove, "aria-label", "Remove page {0} from output", [number]); actions.append(up, down, remove); row.append(actions); rows.append(row);
      });
      pagination.hidden = order.length <= 100; previous.disabled = previewOffset === 0; next.disabled = previewOffset+100 >= order.length; describe();
    }
    function movePage(index, delta) { [order[index], order[index+delta]] = [order[index+delta], order[index]]; invalidate(); renderPages(); }
    if (operation === "merge") { workspace.append(uiNode("p", "helper", "Select PDFs and use the arrows to set their merge order."), rows); }
    else {
      const choose = node("label", "field"), sourceSelect = node("select"); window.CeasefireI18n.attr(sourceSelect, "aria-label", "Source Document"); choose.append(uiNode("span", "", "Source Document"), sourceSelect);
      for (const value of documents) { const option = uiNode("option", "", "{0} ({1} pages)", [value.name, value.pages.length]); option.value = value.id; sourceSelect.append(option); } sourceSelect.value = sourceId;
      const pages = node("label", "field"), apply = uiMake("Apply page order", () => { try { order = parsePages(orderText.value, source().pages.length); previewOffset = 0; invalidate(); renderPages(); } catch (value) { error(value); } });
      pages.append(uiNode("span", "", operation === "extract" ? "Pages to extract, in output order" : "Page order (numbers or ranges)"), orderText);
      workspace.append(choose, pages, apply);
      if (operation === "organise") {
        const removeField = node("label", "field"), removeText = node("input"); removeText.type = "text"; removeText.maxLength = 20000; removeText.placeholder = "2, 4-6"; window.CeasefireI18n.attr(removeText, "aria-label", "Pages to delete"); removeField.append(uiNode("span", "", "Pages to delete from the output"), removeText);
        const remove = uiMake("Delete selected pages", () => { try { const deleted = new Set(parsePages(removeText.value, source().pages.length)), kept = order.filter(value => !deleted.has(value)); if (!kept.length) throw new Error("Keep at least one page in the new PDF."); order = kept; removeText.value = ""; invalidate(); renderPages(); } catch (value) { error(value); } });
        workspace.append(removeField, remove);
      }
      workspace.append(uiNode("p", "helper", "Use the arrows or enter a page order. Removing a page here affects only the new PDF."), rows, pagination);
      sourceSelect.addEventListener("change", () => { sourceId = sourceSelect.value; order = Array.from({length:pageCount(source().pages.length)}, (_,index) => index+1); previewOffset = 0; invalidate(); renderPages(); });
      order = Array.from({length:pageCount(source().pages.length)}, (_,index) => index+1);
    }
    outputSelect.addEventListener("change", () => { status.textContent = ""; });
    const cancel = uiMake("Cancel", () => { if (!pending) dialog.close("cancel"); });
    const create = uiMake("Create PDF", async () => {
      if (pending) return;
      const disabled = new Map();
      try {
        // Typed page order must be applied as part of this one explicit command.
        if (operation !== "merge") { order = parsePages(orderText.value, source().pages.length); renderPages(); }
        const body = payload(), fingerprint = JSON.stringify(body), action = operation === "organise" ? "download" : outputSelect.value;
        pending = true; for (const control of dialog.querySelectorAll("button,input,select")) { disabled.set(control,control.disabled); control.disabled = true; } dialog.setAttribute("aria-busy", "true"); window.CeasefireI18n.text(status, "Preparing the new PDF…");
        if (!prepared || prepared.fingerprint !== fingerprint) prepared = { ...await checkedResult(await requestPDF(body), operation), fingerprint };
        result = { blob:prepared.blob, filename:prepared.filename, action };
        if (typeof onResult === "function") await onResult(result);
        else {
          const url = root.URL.createObjectURL(result.blob), link = doc.createElement("a"); link.href = url; link.download = result.filename; doc.body.append(link); link.click(); link.remove(); root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
        }
        dialog.close("created");
      } catch (value) { result = null; error(value); }
      finally { pending = false; dialog.removeAttribute("aria-busy"); for (const [control,value] of disabled) control.disabled = value; describe(); }
    }, true);
    controls.append(create, cancel); dialog.append(title, intro, workspace, summary, output, status, controls);
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (!pending) dialog.close("cancel"); });
    active = dialog; doc.body.append(dialog); operation === "merge" ? renderMerge() : renderPages();
    try { dialog.showModal(); await new Promise(resolve => dialog.addEventListener("close", resolve, {once:true})); return result; }
    finally { pending = false; active = null; dialog.remove(); }
  }
  const api = Object.freeze({parsePages,formatPages,request,open,hasPendingOperation:()=>pending,hasOpenDialog:()=>!!active});
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffPDFTools = api;
})(typeof window === "object" ? window : null);
