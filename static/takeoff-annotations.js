"use strict";

// Presentation text is structured data. Imported HTML is never rendered or stored.
(() => {
  const fallback = Object.freeze({ stroke_color: "#FF3300", fill_color: "#FFDD33", font_color: "#000000", stroke_width: 4, fill_enabled: true, opacity: .75 });
  const defaultsKey = "ceasefire.takeoff-callout-defaults.v1";
  function validAppearance(value) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      ["stroke_color", "fill_color", "font_color"].every(key => /^#[0-9a-f]{6}$/i.test(value[key])) &&
      typeof value.fill_enabled === "boolean" && Number.isFinite(value.stroke_width) && value.stroke_width >= 1 && value.stroke_width <= 100 &&
      Number.isFinite(value.opacity) && value.opacity >= .01 && value.opacity <= 1;
  }
  let chosen;
  function defaults() {
    if (!chosen) {
      try { const saved = JSON.parse(window.localStorage?.getItem(defaultsKey) || "null"); if (saved?.version === 1 && validAppearance(saved.appearance)) chosen = saved.appearance; } catch { /* Use built-in defaults. */ }
    }
    return { ...fallback, ...chosen };
  }
  function setDefaults(appearance) {
    if (!validAppearance(appearance)) throw new Error("Choose valid Call-out colours, width and opacity before saving defaults.");
    chosen = Object.fromEntries(Object.keys(fallback).map(key => [key, appearance[key]]));
    try { window.localStorage?.setItem(defaultsKey, JSON.stringify({ version: 1, appearance: chosen })); } catch { /* Defaults still apply in this window. */ }
  }
  function validateContent(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 64) throw new Error("Item Details supports 1–64 paragraphs or list entries.");
    let runs = 0, chars = 0;
    for (const block of value.blocks) {
      if (!block || !["paragraph", "bullet", "number"].includes(block.kind) || !Array.isArray(block.runs) || !block.runs.length) throw new Error("Choose paragraphs or lists with text runs.");
      for (const run of block.runs) {
        runs++; if (!run || typeof run.text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(run.text) || Object.keys(run).some(key => !["text", "bold", "italic", "underline"].includes(key)) || ["bold", "italic", "underline"].some(key => run[key] !== undefined && typeof run[key] !== "boolean")) throw new Error("Item Details contains unsupported formatting or control characters.");
        chars += run.text.length;
      }
    }
    if (runs > 256 || chars > 8000) throw new Error("Item Details supports up to 8,000 characters and 256 formatted text runs.");
    return value;
  }
  function text(value) { return value.blocks.map(block => block.runs.map(run => run.text).join("")).join("\n"); }
  function appendRun(parent, run) {
    let target = parent;
    for (const [key, tag] of [["bold", "strong"], ["italic", "em"], ["underline", "u"]]) if (run[key]) { const child = document.createElement(tag); target.append(child); target = child; }
    target.append(document.createTextNode(run.text));
  }
  function populate(editor, content) {
    validateContent(content); editor.replaceChildren();
    for (const block of content.blocks) {
      const element = document.createElement(block.kind === "paragraph" ? "div" : "li");
      if (block.kind === "paragraph") editor.append(element);
      else { const previous = editor.lastElementChild, tag = block.kind === "bullet" ? "UL" : "OL", list = previous?.tagName === tag ? previous : document.createElement(tag.toLowerCase()); if (list !== previous) editor.append(list); list.append(element); }
      for (const run of block.runs) appendRun(element, run);
      if (!element.textContent) element.append(document.createElement("br"));
    }
  }
  function capture(editor) {
    const blocks = []; let current = null;
    const start = kind => { current = { kind, runs: [] }; blocks.push(current); };
    const add = (value, marks) => {
      if (!current) start("paragraph");
      const previous = current.runs.at(-1), keys = ["bold", "italic", "underline"];
      if (previous && keys.every(key => !!previous[key] === !!marks[key])) previous.text += value;
      else current.runs.push({ text: value, ...Object.fromEntries(keys.filter(key => marks[key]).map(key => [key, true])) });
    };
    const visit = (element, marks = {}, kind = "paragraph") => {
      if (element.nodeType === 3) { add(element.nodeValue, marks); return; }
      if (element.nodeType !== 1) return;
      const tag = element.tagName;
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "IMG", "SVG", "MATH"].includes(tag)) return;
      if (tag === "BR") { if (current?.runs.length) add("\n", marks); else if (!current) start(kind); return; }
      const block = ["DIV", "P", "LI"].includes(tag);
      if (block) start(tag === "LI" ? kind : "paragraph");
      const owned = block ? current : null, ownedIndex = blocks.length - 1;
      const next = { ...marks, ...(["B", "STRONG"].includes(tag) ? { bold: true } : {}), ...(["I", "EM"].includes(tag) ? { italic: true } : {}), ...(tag === "U" ? { underline: true } : {}) };
      for (const child of element.childNodes) visit(child, next, tag === "UL" ? "bullet" : tag === "OL" ? "number" : kind);
      if (block) { if (!owned.runs.length) { if (blocks.length > ownedIndex + 1) blocks.splice(ownedIndex, 1); else owned.runs.push({ text: "" }); } current = null; }
    };
    for (const child of editor.childNodes) visit(child);
    if (!blocks.length) blocks.push({ kind: "paragraph", runs: [{ text: "" }] });
    for (const block of blocks) if (!block.runs.length) block.runs.push({ text: "" });
    return validateContent({ version: 1, blocks });
  }
  function richEditor(content, changed) {
    const wrap = document.createElement("div"), toolbar = document.createElement("div"), editor = document.createElement("div");
    wrap.className = "takeoff-rich-details"; toolbar.className = "takeoff-rich-toolbar"; toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "Item Details formatting");
    editor.className = "takeoff-rich-editor"; editor.contentEditable = "true"; editor.setAttribute("role", "textbox"); editor.setAttribute("aria-label", "Item Details"); editor.setAttribute("aria-multiline", "true"); populate(editor, content);
    for (const [label, command, symbol] of [["Bold", "bold", "B"], ["Italic", "italic", "I"], ["Underline", "underline", "U"], ["Bullet list", "insertUnorderedList", "•"], ["Numbered list", "insertOrderedList", "1."]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = symbol; button.title = label; button.setAttribute("aria-label", label);
      if (["insertUnorderedList", "insertOrderedList"].includes(command)) { const icon = document.createElement("img"); icon.src = command === "insertUnorderedList" ? "/icons/takeoff-bullet-list.png" : "/icons/takeoff-numbered-list.png"; icon.alt = ""; icon.width = 20; icon.height = 20; button.replaceChildren(icon); }
      button.addEventListener("pointerdown", event => event.preventDefault());
      button.addEventListener("click", () => { editor.focus(); document.execCommand(command, false); changed(); }); toolbar.append(button);
    }
    editor.addEventListener("input", changed);
    editor.addEventListener("paste", event => {
      event.preventDefault(); const value = event.clipboardData?.getData("text/plain") || "";
      if (value.length > 8000) return;
      // Fixed insertText command preserves native editing undo; pasted HTML is discarded.
      document.execCommand("insertText", false, value); changed();
    });
    editor.addEventListener("drop", event => event.preventDefault());
    wrap.append(toolbar, editor); return { wrap, editor, read: () => capture(editor) };
  }
  let measure;
  function layout(content, width, height) {
    validateContent(content); measure ||= document.createElement("canvas").getContext("2d");
    const padding = Math.min(6, width / 12, height / 8);
    const wrap = size => {
      const lines = []; let number = 0;
      for (const block of content.blocks) {
        const prefix = block.kind === "bullet" ? "• " : block.kind === "number" ? `${++number}. ` : ""; if (block.kind !== "number") number = 0;
        let line = [], length = 0;
        for (const run of [...(prefix ? [{ text: prefix }] : []), ...block.runs]) {
          measure.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${size}px CeasefireDrawing`; measure.fontKerning = "none";
          for (const character of run.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ")) {
            const advance = measure.measureText(character === "\t" ? "    " : character).width;
            if (advance > width - padding * 2) return null;
            if (character === "\n" || length && length + advance > width - padding * 2) { lines.push(line); line = []; length = 0; if (character === "\n") continue; }
            line.push({ ...run, text: character === "\t" ? "    " : character, x: length }); length += advance;
          }
        }
        lines.push(line);
      }
      return lines;
    };
    for (let size = 10; ; size = Math.max(4, size * .9)) { const lines = wrap(size); if (lines && lines.length * size * 1.3 <= height - padding * 2) return { lines, size, padding }; if (size === 4) break; }
    throw new Error("Item Details does not fit this Call-out. Shorten the text or resize the box.");
  }
  window.CeasefireTakeoffAnnotations = { defaults, setDefaults, validateContent, text, richEditor, layout };
})();
