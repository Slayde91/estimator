(function (root) {
  "use strict";

  // Presentation only: the original source text remains in the library record.
  const sourcePage = /^source pages?\s+\d+(?:\s*(?:,|&|and|[-–—])\s*\d+)*[.:]?$/i;
  const cleanLine = line => line.replace(/[\t\u00a0 ]+/g, " ").trim();
  const join = (left, right) => left ? `${left}${/[A-Za-z0-9]-$/.test(left) && /^[a-z]/.test(right) || /^[.,;!?]/.test(right) ? "" : " "}${right}` : right;
  const heading = line => /^[A-Za-z][A-Za-z /-]{0,60}:$/.test(line) || /^OR$/.test(line);
  const endsInConnector = text => /(?:\b(?:of|the|and|or|with|using|in|to|on|at|by|from|for|as|a|an|into|either|each)|[×,])$/i.test(text);

  function marker(line, listContext = false) {
    // A delimiter followed by whitespace is required: 1.5 mm and clauses 3.2
    // are measurements/references, not list markers. Years are not step numbers.
    const numbered = /^((?:([1-9]\d?)[.)]|\(([1-9]\d?)\)))\s+(.+)$/.exec(line);
    if (numbered) {
      let text = numbered[4];
      // An identical repeated prefix is an extraction-format error, not a
      // second step. Do not change distinct subclauses such as 2.2 or 2. 3.
      while (text.startsWith(`${numbered[1]} `)) text = text.slice(numbered[1].length).trimStart();
      return { ordered: true, number: Number(numbered[2] || numbered[3]), text };
    }
    // A spaced FRL dash is still part of the rating. A lone negative number is
    // not a bullet, but quantified service lines and established lists are.
    if (/^[-−–]\s+\//.test(line)) return null;
    const quantified = /^[-−–]\s+\d+\s*[×x]\s/.test(line);
    const bullet = (listContext || quantified ? /^(?:[•●▪‣◦*−–-])\s+(.+)$/ : /^(?:[•●▪‣◦*]|[-−–](?=\s+[^\d]))\s+(.+)$/).exec(line);
    return bullet ? { ordered: false, text: bullet[1] } : null;
  }

  function parse(value) {
    const lines = String(value ?? "").replace(/\r\n?|[\f\u2028\u2029]/g, "\n").split("\n").map(cleanLine);
    const blocks = [];
    let paragraph = null, list = null, item = null, nested = null, nestedItem = null, gap = false;
    const end = () => { paragraph = null; list = null; item = null; nested = null; nestedItem = null; gap = false; };
    const addParagraph = text => { paragraph = { type: "paragraph", text }; blocks.push(paragraph); };
    const addItem = (target, found) => {
      const result = { text: found.text, children: [] };
      if (found.ordered) result.number = found.number;
      target.items.push(result);
      return result;
    };

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (!line) { gap = true; continue; }
      if (sourcePage.test(line)) { end(); continue; }
      // PDF extraction occasionally puts a bullet on its own line. Join it to
      // the following content, never render an empty list item.
      if (/^[•●▪‣◦*−–-]$/.test(line)) {
        const next = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate);
        if (next !== -1 && !sourcePage.test(lines[next]) && !marker(lines[next])) {
          line = `${line} ${lines[next]}`;
          index = next;
        } else {
          // Keep unmatched punctuation as text instead of discarding evidence.
          end(); addParagraph(line); continue;
        }
      }
      const found = marker(line, Boolean(nested || list && !list.ordered || /:$/.test((item || paragraph)?.text || "")));
      if (found) {
        paragraph = null;
        if (!found.ordered && list?.ordered && item && (nested || /:$/.test(item.text))) {
          if (!nested) { nested = { type: "list", ordered: false, items: [] }; item.children.push(nested); }
          nestedItem = addItem(nested, found);
        } else {
          // Numbering resets represent a new list; gaps/skipped numbers retain
          // their explicit values so a source step is never silently renumbered.
          if (!list || list.ordered !== found.ordered || found.ordered && found.number <= item.number) {
            list = { type: "list", ordered: found.ordered, items: [] }; blocks.push(list);
          }
          item = addItem(list, found); nested = null; nestedItem = null;
        }
        gap = false; continue;
      }
      const current = nestedItem || item || paragraph;
      // A short colon-ending line can be the end of a wrapped instruction,
      // e.g. "install the 1st layer of\nFIREFLYBatt using:". Keep that intro
      // with its step so the following bullets belong to the same operation.
      const continuesIntro = current && !/[.!?:]$/.test(current.text) && (/^[a-z]/.test(line) || endsInConnector(current.text));
      if (heading(line) && (!continuesIntro || /^(?:NOTE[S]?:|OR)$/.test(line))) { end(); addParagraph(line); continue; }
      // A period extracted onto a separate line belongs to its sentence. If
      // that sentence already ends with a period, it is duplicate punctuation.
      if (line === "." && current) {
        if (!current.text.endsWith(".")) current.text += ".";
        gap = false; continue;
      }
      // Blank lines inside a wrapped sentence are PDF layout gaps. Genuine
      // paragraph breaks after a complete sentence remain paragraph breaks.
      if (gap && current && /[.!?:]$/.test(current.text) && !/^[a-z]/.test(line)) end();
      if (nestedItem) nestedItem.text = join(nestedItem.text, line);
      else if (item) item.text = join(item.text, line);
      else if (paragraph && !heading(paragraph.text)) paragraph.text = join(paragraph.text, line);
      else addParagraph(line);
      gap = false;
    }
    return blocks;
  }

  function render(document, value) {
    const renderBlock = block => {
      if (block.type === "paragraph") {
        const paragraph = document.createElement("p"); paragraph.textContent = block.text; return paragraph;
      }
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.items[0].number !== 1) list.setAttribute("start", String(block.items[0].number));
      for (const item of block.items) {
        const element = document.createElement("li");
        if (block.ordered) element.setAttribute("value", String(item.number));
        element.textContent = item.text;
        element.append(...item.children.map(renderBlock));
        list.append(element);
      }
      return list;
    };
    return parse(value).map(renderBlock);
  }

  const api = Object.freeze({ parse, render });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LibraryDetailText = api;
})(typeof window !== "undefined" ? window : globalThis);
