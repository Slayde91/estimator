"use strict";

// Help is a read-only catalogue. It never dispatches the controls it describes.
(function (root) {
  const groups = ["Navigation", "Projects and files", "Documents", "Estimating and libraries", "Drawing tools", "Drawing view", "Register and selection", "Keyboard and mouse"];
  // These paths are the same paths used by the Takeoffs button factory.
  const paths = {
    select: "M5 3l14 10-7 1-3 7z",
    text: "M6 3c4 0 6 2 6 5v8c0 3-2 5-6 5M18 3c-4 0-6 2-6 5M12 16c0 3 2 5 6 5",
    pan: "M8 12V5a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v7c0 4-3 6-7 6-3 0-4-2-6-4l-3-4a1.5 1.5 0 0 1 2-2l2 1z",
    settings: "M10 2h4l1 3 2.8-1.3 2.5 2.5L19 9l3 1v4l-3 1 1.3 2.8-2.5 2.5L15 19l-1 3h-4l-1-3-2.8 1.3-2.5-2.5L5 15l-3-1v-4l3-1-1.3-2.8 2.5-2.5L9 5z",
    length: "M1 6v12M23 6v12M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
    count: "M5 3v18M10 3v18M15 3v18M20 3v18M2 7l21 10",
    area: "M7 3h14v14H7zM3 3v14M1 5l2-2 2 2M1 15l2 2 2-2M7 21h14M9 19l-2 2 2 2M19 19l2 2-2 2",
    scale: "M2 7h20v10H2zM6 7v5M10 7v3M14 7v5M18 7v3",
    viewport: "M7 3H3v4M17 3h4v4M3 17v4h4M21 17v4h-4M7 7h10v10H7z",
    bin: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    search: "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    stop: "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 7l6 6M13 7l-6 6",
    fit: "M9 9L3 3m0 5V3h5M15 9l6-6m-5 0h5v5M9 15l-6 6m0-5v5h5M15 15l6 6m-5 0h5v-5",
    rotate: "M12 6l6 6-6 6-6-6zM13 3a9 9 0 0 1 7 15m0-4v4h3M11 21A9 9 0 0 1 4 6m0 4V6H1",
    checked: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M7 12l3 3 7-7",
    update: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 6v6h6",
    unlink: "M15 7h2a5 5 0 0 1 0 10h-2M9 17H7A5 5 0 0 1 7 7h2",
    first: "M4 5v14M17 5l-7 7 7 7", previous: "M15 5l-7 7 7 7",
    next: "M9 5l7 7-7 7", last: "M20 5v14M7 5l7 7-7 7",
  };
  function catalogue(registry, takeoffs = true) {
    const rows = [];
    const add = (group, name, description, icon, extra = {}) => rows.push({ group, name, description, icon, ...extra });
    const nav = (name, view, detail) => add("Navigation", name, detail, { selector: `.app-header [data-view="${view}"]` });
    nav("Home", "home", "Open the workspace starting page.");
    nav("Estimates", "estimate", "Choose Main or Firestopping and review the estimate.");
    nav("Calculators", "calculators", "Choose Firestopping, Steel Spray, Steel Board or Ductwork.");
    if (takeoffs) nav("Takeoffs", "takeoffs", "Choose Steel, Duct, Penetrations, Defect Reports, Service Plans or Walls/Floors.");
    nav("Libraries", "pricing", "Choose Pricing, Firestopping or Technical Library.");
    nav("Projects", "quotes", "Find, load and browse project files.");
    nav("Help", "help", "Open the guide and this button glossary.");
    add("Navigation", "Theme", "Cycle through Ceasefire, Midnight, Ocean, Forest and Slate.", { selector: "#theme-toggle" });
    add("Projects and files", "Save", "Choose a location for a new project, or update the selected .cf.json project file.", { selector: "#save-current-project" });
    add("Projects and files", "New", "Start a new estimate after reviewing the replacement prompt.", { text: "New" });
    add("Projects and files", "Load / Open project", "Load a .cf.json project and its saved prices and drafts after confirming replacement.", { text: "Load" });
    add("Projects and files", "Link Project Folder", "Choose the folder Projects searches for .cf.json files.", { selector: "#link-project-folder" });
    add("Projects and files", "Refresh", "Read the linked project folder again.", { selector: "#refresh-quotes" });
    add("Projects and files", "Project files", "Attach files beside a saved project. You can also drag files onto this button.", { selector: "#project-attachment-zone" });
    add("Projects and files", "Project search and sort", "Filter the project list by project, client, address or folder; choose its order.", { text: "Search" });
    add("Projects and files", "Previous / Next / Continue folder scan", "Move between project results or continue a bounded folder scan.", { text: "Next" });
    add("Projects and files", "Folder breadcrumbs / Back to Projects", "Browse attached folders and return to the project list.", { text: "Back" });
    add("Documents", "Document", "Open the imports, templates and downloads available in the current workspace.", { asset: "document.png" }, { keys: ["↑ / ↓", "Home / End", "Esc"] });
    add("Documents", "Download Estimate Summary", "Save the Main estimate PDF using the inputs and prices captured when you click.", { format: "PDF", symbol: "Σ" });
    add("Documents", "Download Firestopping Schedule", "Save the complete current Firestopping Schedule as XLSX or PDF.", { format: "XLSX / PDF" });
    add("Documents", "Download Current Item", "Save the current Firestopping item's relevant fields as XLSX or PDF; the PDF includes its attached source diagram.", { format: "XLSX / PDF" });
    add("Documents", "Download schedule / summary", "Save the selected calculator's schedule or PDF summary.", { format: "XLSX / PDF" });
    add("Documents", "Import XLSX Schedule / Export Template", "Use the supported calculator template. Review the confirmation before replacing a schedule draft.", { format: "XLSX", symbol: "⇧ / ⇩" });
    add("Documents", "Export Excel / Import Excel", "Export the whole pricing draft, or import a complete pricing workbook for review.", { format: "XLSX", symbol: "⇩ / ⇧" });
    add("Estimating and libraries", "Recalculate", "Calculate the current workbook or schedule from its valid inputs.", { selector: "#calculator-recalculate" });
    add("Estimating and libraries", "Settings", "Open the current calculator or Firestopping settings.", { path: "settings" });
    add("Estimating and libraries", "Add item / Add row", "Add the current completed Firestopping item or a new schedule row.", { text: "+" });
    add("Estimating and libraries", "Duplicate", "Copy a work-item or schedule row with its existing inputs.", { text: "⧉" });
    add("Estimating and libraries", "Remove / Delete", "Remove the selected row, item or library record after any displayed confirmation.", { path: "bin" });
    add("Estimating and libraries", "Undo", "Restore the most recently removed schedule row, or undo the available last edit.", { text: "↶" });
    add("Estimating and libraries", "Clear current item / Reset", "Clear the Firestopping current item, or load the selected calculator's defaults after its prompt.", { selector: "#penetration-clear", fallback: "Reset" });
    add("Estimating and libraries", "Save pricing / Apply / Discard", "Save shared pricing, apply project pricing, or return the draft to its saved values.", { selector: "#save-pricing", fallback: "Save" });
    add("Estimating and libraries", "Use current pricing", "Replace the project's saved pricing snapshot with the current Main Library and recalculate.", { text: "Use current pricing" });
    add("Estimating and libraries", "Edit / Back to previous item", "Edit a library record or return to the previous record or results.", { text: "Edit" });
    add("Estimating and libraries", "Add to Library", "Create a reusable Firestopping Library item from the current item's completed inputs.", { selector: "#penetration-add-to-library" });
    add("Estimating and libraries", "Source diagram / Open image", "Attach a source diagram to the current Firestopping item, or open a library image at full size.", { text: "Diagram" });
    add("Estimating and libraries", "Link Library Item / Unlink", "Choose one or more filtered Technical Library references, or remove an association.", { path: "unlink" });
    add("Estimating and libraries", "Add to Schedule", "Add the Firestopping Library item to the current schedule.", takeoffs ? { asset: "takeoff-transfer.png" } : { text: "+" });
    if (takeoffs) {
      const tool = (name, action, detail, icon) => add("Drawing tools", name, detail, icon, { action });
      tool("Select", "select", "Select a markup, drag selected geometry or drag a selection rectangle.", { path: "select" });
      tool("Pan", "pan", "Drag the drawing without changing its markups.", { path: "pan" });
      tool("Settings", "settings", "Edit the selected markup's appearance and item details.", { path: "settings" });
      tool("Viewport", "viewport", "Manage named drawing regions and their separate scales.", { path: "viewport" });
      tool("Calibrate", "calibrate", "Mark a known distance and enter its real length to establish scale.", { path: "scale" });
      tool("Trace length", "trace", "Click points along a Steel or Duct run, then finish the trace.", { path: "length" });
      tool("Count", "count", "Place count markers. Penetration workspaces use their Call-out action for physical items.", { path: "count" });
      tool("Count steel lengths", "countLength", "Place markers for repeated steel members with a stated length each.", { path: "count" });
      tool("Trace surface", "polygon", "Trace a closed Wall/Floor surface. Display Values shows measured net Sqm before Number of layers multiplies it.", { path: "area" });
      tool("Add exclusion", "exclusion", "Trace an excluded area within the selected Wall/Floor surface.", { path: "area", cross: true });
      tool("Length", "measure", "Measure a standalone calibrated length on the drawing.", { path: "length" });
      tool("Markups", "markups", "Turn thickness-based colours on or off for Steel drawing markups.", { asset: "takeoff-colour-wheel.png", colour: true });
      tool("Legend", "legend", "Show a drawing legend; select it to change its position, size or settings.", { asset: "takeoff-legend.png" });
      tool("Visibility", "visibility", "Click to show or hide all drawing markups. Double-click restores individually hidden items and shows all markups. The eye beside an item changes only that item's visibility.", { asset: "takeoff-visibility.png" });
      tool("Call-out", "callout", "Place a text Call-out. In Penetrations, place a physical item Call-out from the current draft.", { asset: "takeoff-callout.png" });
      tool("Signatures", "signature", "Draw a signature or reuse the last one, then place it on the PDF. Select it to move, resize or delete it.", { asset: "signature.svg", mask: true });
      add("Drawing tools", "Set as default", "Remember the current appearance for new markups of that kind.", { asset: "default-memory.svg", mask: true });
      add("Drawing tools", "Display Values", "Show or hide measured values on the drawing. New Wall/Floor surfaces start with values visible.", { text: "✓" });
      add("Drawing tools", "Re-trace geometry / Exclusions", "Replace a selected surface boundary, or edit or remove one of its exclusions.", { path: "area" });
      add("Drawing view", "Upload PDFs", "Add source PDF documents to the current project.", { selector: "#project-attachment-zone" });
      add("Drawing view", "Document / Remove document", "Choose an uploaded PDF, or remove the current source after confirmation.", { path: "bin" });
      add("Drawing view", "Scale / Edit calibration", "Choose or edit the applicable page or viewport calibration.", { path: "scale" });
      add("Drawing view", "Search / Stop search", "Search PDF text and optional drawing labels in this document or all documents. Stop clears the search and highlights.", { path: "search" }, { keys: ["Enter", "↓", "Esc"] });
      add("Drawing view", "Select PDF text", "Drag over embedded PDF text and copy the selection.", { path: "text" }, { keys: ["Ctrl / Cmd+C"] });
      add("Drawing view", "First / Previous / Next / Last page", "Move through the PDF, or enter its page number.", { path: "previous" }, { keys: ["Ctrl+← / →"] });
      add("Drawing view", "Rotate page", "Rotate the displayed page 90 degrees left or right.", { path: "rotate" }, { keys: ["Ctrl+↑ / ↓"] });
      add("Drawing view", "Fit page", "Fit the complete drawing in the viewer.", { path: "fit" }, { keys: ["Ctrl+0"] });
      add("Drawing view", "Zoom out / Zoom in", "Change drawing magnification, keeping the drawing point at the viewer centre.", { text: "− / +" }, { keys: ["Ctrl+− / +", "Ctrl / Cmd+wheel"] });
      add("Drawing view", "Download PDF", "Save the marked-up PDF from the current drawing workspace.", { format: "PDF" });
      add("Register and selection", "Filter / Sort / Group", "Narrow the register, choose its order or group items. Column funnels filter individual fields.", { text: "Filter" });
      add("Register and selection", "Select filtered items / Select filtered records", "Select or clear the currently filtered register rows.", { path: "checked" });
      add("Register and selection", "Hide / Visibility", "Hide an individual row's drawing markup without deleting the item.", { asset: "takeoff-visibility.png" });
      add("Register and selection", "View / Edit item", "Centre the drawing on an item or open its editable details.", { text: "View / Edit" });
      add("Register and selection", "Apply to selected", "Apply only the fields you changed to the selected items.", { text: "Apply" });
      add("Register and selection", "Confirm / Unconfirm", "Change the selected records' manual review status.", { text: "Confirm" });
      add("Register and selection", "Undo last edit", "Undo the latest available Takeoff edit.", { text: "↶" });
      add("Register and selection", "Delete", "Delete selected items after the displayed confirmation.", { path: "bin" });
      add("Register and selection", "Split / Merge", "Split a traced Steel/Duct run at a chosen point, or merge eligible connected length items.", { text: "Split / Merge" });
      add("Register and selection", "Preview transfer / Transfer", "Review selected quantities before applying them to the destination calculator schedule.", { asset: "takeoff-transfer.png" });
      add("Register and selection", "Update linked rows", "Review and update existing linked calculator rows from their Takeoff items.", { path: "update" });
      add("Register and selection", "Detach links / Unlink from Firestopping Schedule", "Remove the selected Takeoff-to-schedule links using the displayed prompt.", { path: "unlink" });
      add("Register and selection", "Add substrate / Add defect / Add service", "Create the next physical record in the current Penetration, Defect Report or Service Plan.", { text: "+" });
      add("Register and selection", "Document downloads", "Download confirmed, unconfirmed or all items from the current register as XLSX.", { format: "XLSX" });
      add("Register and selection", "Download Passive Fire Matrix PDF", "Save the physical hierarchy's current Passive Fire Matrix report.", { format: "PDF" });
      add("Register and selection", "Show deleted records", "Include deleted physical records in the current register view.", { text: "✓" });
      add("Register and selection", "Discard unfinished physical edits", "Discard pending field edits and return to the recorded draft values.", { text: "⊗" });
      add("Register and selection", "Previous 100 / Next 100 / Register layout", "Page through register rows, or position the register below or beside the drawing.", { text: "Next 100" });
      add("Drawing tools", "Continue count / Delete count marker", "Resume a count from its marker's context menu, or remove that individual marker.", { path: "count" });
      add("Drawing tools", "Call-out formatting", "Use Bold, Italic, Underline and bullet or numbered list buttons in Call-out Settings.", { text: "B I U" });
      add("Keyboard and mouse", "Finish / Cancel drawing", "With drawing focus, Enter finishes a trace; Escape or right-click cancels the active drawing operation.", { text: "Enter" }, { keys: ["Enter", "Esc", "Right-click"] });
      add("Keyboard and mouse", "Undo drawing point", "Backspace removes the last unfinished trace point. Ctrl/Cmd+Z also removes a chosen control point, or undoes a supported count, Call-out or signature edit.", { text: "↶" }, { keys: ["Backspace", "Ctrl / Cmd+Z"] });
      add("Keyboard and mouse", "Copy / Paste drawing selection", "With Select active, copy and paste free or physical Call-outs, Steel/Duct Length markups or Wall/Floor surfaces. Copies are separate records; pasted quantity items start unconfirmed and use the destination drawing position and calibration.", { text: "Copy / Paste" }, { keys: ["Ctrl / Cmd+C", "Ctrl / Cmd+V"], id: "drawing-copy" });
      add("Keyboard and mouse", "Multiple selection", "Hold Ctrl, Cmd or Shift when choosing drawing items to extend or toggle the selection.", { path: "checked" }, { keys: ["Ctrl / Cmd / Shift+click"] });
      add("Keyboard and mouse", "Drawing context actions", "Open actions for a focused markup, Call-out or control point.", { text: "⋯" }, { keys: ["Right-click", "Shift+F10", "Menu key"] });
      add("Keyboard and mouse", "Steel section choices", "Type to filter section names; arrows or Home/End choose a match, Enter accepts and Escape restores the previous choice.", { text: "Search" }, { keys: ["↑ / ↓", "Home / End", "Enter", "Esc"] });
    }
    add("Keyboard and mouse", "Move focus / Activate", "Tab and Shift+Tab move through controls. Enter or Space activates a focused button.", { text: "Tab" }, { keys: ["Tab / Shift+Tab", "Enter / Space"] });
    add("Keyboard and mouse", "Navigate a menu", "Use arrows to move through navigation or Document choices, Home/End for first/last, and Escape to close. In the Firestopping navigation branch, Right opens and Left returns.", { text: "↑ ↓" }, { keys: ["↑ / ↓", "Home / End", "Esc", "← / →"] });
    return rows.map(row => ({ ...row, keys: row.action && registry?.actions?.[row.action] ? [`Ctrl+${registry.actions[row.action].key}`] : row.keys || [] }));
  }
  function matches(row, query, group = "") {
    const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shortcuts = row.keys.flatMap(key => [key, key.replace(/Ctrl\s*\/\s*Cmd/g, "Ctrl"), key.replace(/Ctrl\s*\/\s*Cmd/g, "Cmd")]);
    const haystack = [row.name, row.description, row.group, ...shortcuts].join(" ").toLowerCase();
    return (!group || row.group === group) && words.every(word => haystack.includes(word));
  }
  function mount(document, registry) {
    const host = document.getElementById("help-glossary-results"); if (!host) return;
    const search = document.getElementById("help-glossary-search"), category = document.getElementById("help-glossary-category"), status = document.getElementById("help-glossary-status");
    const rows = catalogue(registry, !!document.getElementById("takeoff-navigation"));
    const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const svgNode = tag => document.createElementNS("http://www.w3.org/2000/svg", tag);
    function icon(definition) {
      const symbol = node("span", "help-glossary-symbol"); symbol.setAttribute("aria-hidden", "true");
      const source = definition.selector && document.querySelector(definition.selector);
      const artwork = source?.querySelector("svg, .button-symbol, .download-format-icon, img");
      if (artwork) {
        const copy = artwork.cloneNode(true); copy.removeAttribute("id"); copy.removeAttribute("tabindex"); copy.setAttribute("aria-hidden", "true"); symbol.append(copy);
      } else if (definition.path) {
        const svg = svgNode("svg"), path = svgNode("path");
        for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" })) svg.setAttribute(name, value);
        path.setAttribute("d", paths[definition.path]); svg.append(path);
        if (definition.path === "settings") { const centre = svgNode("circle"); centre.setAttribute("cx", "12"); centre.setAttribute("cy", "12"); centre.setAttribute("r", "4.5"); svg.append(centre); }
        if (definition.path === "area") { const label = svgNode("text"); for (const [key, value] of Object.entries({ x: "14", y: "11", "text-anchor": "middle", "font-family": "Arial, sans-serif", "font-size": "7", "font-weight": "600", fill: "currentColor", stroke: "none" })) label.setAttribute(key, value); label.textContent = "m²"; svg.append(label); }
        if (definition.cross) for (const [stroke, width] of [["var(--paper)", "4"], ["currentColor", "1.8"]]) { const cross = svgNode("path"); cross.setAttribute("d", "M15 12l8 8M23 12l-8 8"); cross.setAttribute("stroke", stroke); cross.setAttribute("stroke-width", width); svg.append(cross); }
        symbol.append(svg);
      } else if (definition.asset) {
        if (definition.mask) symbol.classList.add(definition.asset === "signature.svg" ? "help-signature-symbol" : "help-default-symbol");
        else { const image = node("img", definition.colour ? "help-colour-icon" : "help-monochrome-icon"); image.src = `/icons/${definition.asset}`; image.alt = ""; image.width = image.height = 28; symbol.append(image); }
      } else if (definition.format) { const badge = node("span", "download-format-icon"); badge.append(node("span", "download-arrow", definition.symbol || "⇩"), node("span", "download-format", definition.format)); symbol.append(badge); }
      else symbol.textContent = definition.text || definition.fallback || "";
      return symbol;
    }
    const sections = groups.filter(group => rows.some(row => row.group === group)).map((group, index) => {
      const option = node("option", "", group); option.value = group; category.append(option);
      const section = node("section", "help-glossary-group"), heading = node("h3", "", group), list = node("ul", "help-glossary-list"); heading.id = `help-glossary-group-${index}`; section.setAttribute("aria-labelledby", heading.id);
      const entries = rows.filter(row => row.group === group).map(row => {
        const item = node("li", "help-glossary-entry"); item.dataset.glossaryName = row.name;
        const copy = node("div", "help-glossary-copy"), name = node("h4", "", row.name); copy.append(name, node("p", "", row.description));
        const keys = node("div", "help-glossary-keys"); if (row.keys.length) { const label = node("span", "sr-only", "Shortcut: "); keys.append(label, ...row.keys.map(key => node("kbd", "", key))); } else keys.append(node("span", "helper", "Button only"));
        item.append(icon(row.icon), copy, keys); list.append(item); return { item, row };
      });
      section.append(heading, list); host.append(section); return { section, entries };
    });
    function filter() {
      let count = 0;
      for (const { section, entries } of sections) { let visible = 0; for (const { item, row } of entries) { item.hidden = !matches(row, search.value, category.value); if (!item.hidden) { visible++; count++; } } section.hidden = !visible; }
      status.textContent = count ? `${count} of ${rows.length} controls and shortcuts shown` : "No matching controls. Try another word or choose all sections.";
    }
    search.addEventListener("input", filter); category.addEventListener("change", filter);
    document.getElementById("help-glossary-clear").addEventListener("click", () => { search.value = ""; category.value = ""; filter(); search.focus(); }); filter();
  }
  const api = Object.freeze({ catalogue, matches });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) mount(root.document, root.CeasefireTakeoffShortcuts);
})(typeof window === "object" ? window : null);
