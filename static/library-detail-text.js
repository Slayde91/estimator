(function (root) {
  "use strict";

  // Presentation only: the original source text remains in the library record.
  const sourcePage = /^source pages?\s+\d+(?:\s*(?:,|&|and|[-–—])\s*\d+)*[.:]?$/i;
  const cleanLine = line => line.replace(/[\t\u00a0 ]+/g, " ").trim()
    // Repair the verified missing sentence space in this imported instruction;
    // do not apply punctuation substitutions to arbitrary identifiers or URLs.
    .replace(/\bapproved Max size\.Cut ryanbatt 502 board\b/g, "approved Max size. Cut ryanbatt 502 board");
  const join = (left, right) => left ? `${left}${/[A-Za-z0-9]-$/.test(left) && /^[a-z]/.test(right) || /^[.,;!?]/.test(right) ? "" : " "}${right}` : right;
  const heading = line => /^[A-Za-z][A-Za-z /-]{0,60}:$/.test(line) || /^OR$/.test(line);
  const longHeading = line => line.length > 61 && /^[A-Za-z][^.!?]*:$/.test(line);
  const endsInConnector = text => /(?:\b(?:of|the|and|or|with|using|in|to|on|at|by|from|for|as|a|an|into|either|each)|[×,])$/i.test(text);

  // Keep these ordered rules aligned with estimator/technical_display.py.
  const compactRules = [
    [/\bFIREFLY(?:TM\b|\u2122)[ \t]*/gi, ""],
    [/\b(Roc)TM\b/gi, "$1"],
    [/(?<![\w-])(?:TBA|TM)(?![\w-])[ \t]*|\u2122/gi, ""],
    [/\bFIREFLY(?=[A-Za-z])/gi, ""],
    [/\bFIREFLY\s+(?=(?:Batts?|Mastic|Penowrap|wrap|Intu[A-Za-z]+)\b)/gi, ""],
    [/\bPenowrap\b[\u00ae\u2122]?/gi, "wrap"],
    [/\bBrush Grade\b/gi, "BG"],
    [/\bincluding\b/gi, "incl."],
    [/\bapproximately\b/gi, "approx."],
    [/\bin order to\b/gi, "to"],
    [/\bin accordance with\b/gi, "per"],
    [/\bas per\b/gi, "per"],
    [/\bprior to\b/gi, "before"],
    [/\bsubsequent to\b/gi, "after"],
    [/\bin the event that\b/gi, "if"],
    [/\bprovided that\b/gi, "provided"],
    [/\bfor the purpose of\b/gi, "for"],
    [/\bin addition to\b/gi, "plus"],
    [/\bin between\b/gi, "between"],
    [/\bSource configuration ratings remain subject to the stated barrier construction and installation conditions\b/gi, "Source ratings subject to stated barrier construction and installation conditions"],
    [/\bThe entry selection remains separate\b/gi, "Entry selection remains separate"],
    [/\bno missing values have been inferred\b/gi, "no missing values inferred"],
    [/\bto ensure that\b/gi, "to ensure"],
    [/\bat a distance of\b/gi, "at"],
    [/\ba minimum of\b|\bminimum of\b/gi, "min."],
    [/\ba maximum of\b|\bmaximum of\b/gi, "max."],
    [/\bminimum\b\.?/gi, "min."],
    [/\bmaximum\b\.?/gi, "max."],
    [/\bis required to be\b/gi, "must be"],
    [/\bare required to be\b/gi, "must be"],
    [/\bis required for\b/gi, "required for"],
    [/\bare required for\b/gi, "required for"],
    [/\bmust be at least\b/gi, "must be min."],
    [/\bat least\b/gi, "min."],
    [/\bat most\b/gi, "max."],
    [/\bon both sides of the wall\b/gi, "on both wall faces"],
    [/\bon each side of the wall\b/gi, "on each wall face"],
    [/\bfrom the face of the wall\b/gi, "from wall face"],
    [/\bthe (Batt layers) are glued together using\b/gi, "Glue $1 together w/"],
    [/\bAll cut edges, incl\. layer joints and the wall perimeter interface, to be coated\b/gi, "Coat all cut edges, incl. layer joints and wall perimeter interface"],
    [/\binto\s+the\s+aperture\b/gi, "to aperture"],
    [/\bof\s+the\s+damper\b/gi, "of damper"],
    [/\bwall\s+thickness\s+of\b/gi, "wall thickness"],
    [/\b(for|to|over)\s+a\s+distance\s+of\b/gi, "$1"],
    [/\b(?:a\s+)?(min\.|max\.)\s+(depth|width|height|length|thickness)\s+of\b/gi, "$1 $2"],
    [/\bto\s+a\s+depth\s+of(?=\s+\d)/gi, "to depth"],
    [/\bthe\s+full\s+depth\b/gi, "full depth"],
    [/\b(requiring|requires)\s+the\s+use\s+of\b/gi, "$1"],
    [/\bbefore\s+the\s+installation\s+of\b/gi, "before installing"],
    [/\bfollowing\s+the\s+installation\s+of\b/gi, "after installing"],
    [/\bduring\s+the\s+installation\s+of\b/gi, "while installing"],
    [/\ba\s+combination\s+of\s+both\b/gi, "both"],
    [/\band\s+also\b/gi, "and"],
    [/\band\s+then\b/gi, "then"],
    [/\b(?:the\s+)+(apertures?|walls?|floors?|ceilings?|slabs?|substrates?|services?|collars?|boards?|seals?|wraps?|openings?|perimeters?|Batts?|annular\s+gaps?|pipes?|layers?|ends?|edges?|faces?|base|top|underside|framing|steel\s+(?:angles?|beams?|plates?|frames?)|joints?|gaps?|separating\s+element|interfacing\s+element|supporting\s+element|configuration\s+table|complete\s+row|selected\s+configuration|use)\b/gi, "$1"],
    [/(?<!when )\busing\b/gi, "w/"],
    [/\bwith\b/gi, "w/"],
    [/\bper\b/gi, "p/"],
    [/\bw\/\s+a\s+w\/\s+a\b/gi, "w/ a"],
    [/\bAll\s+joints\s+between\s+Batt\s+sections\s+are\s+glued\s+and\s+sealed\s+w\//gi, "Glue and seal all joints between Batt sections w/"],
    [/\bBatt\s+layers\s+are\s+glued\s+together\s+at\s+perimeter\s+bond\s+employing\b/gi, "Glue Batt layers together at perimeter bond w/"],
  ];

  function compact(value) {
    const text = String(value ?? ""), protectedText = /https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b[\w.-]+\.(?:pdf|xlsx?|docx?|png|jpe?g|json)\b/gi;
    const prose = part => compactRules.reduce((text, [expression, replacement]) => text.replace(expression, replacement), part);
    let result = "", cursor = 0;
    for (const match of text.matchAll(protectedText)) {
      result += prose(text.slice(cursor, match.index)) + match[0]; cursor = match.index + match[0].length;
    }
    let shortened = result + prose(text.slice(cursor));
    const protectedRanges = [...shortened.matchAll(protectedText)].map(match => [match.index, match.index + match[0].length]);
    const leadingLetter = /^([\s"'\u2018\u201c(\[]*)([A-Za-z])/;
    const originalStart = leadingLetter.exec(text), shortenedStart = leadingLetter.exec(shortened);
    if (originalStart && shortenedStart && /[A-Z]/.test(originalStart[2])
        && !protectedRanges.some(([start, end]) => start <= shortenedStart[1].length && shortenedStart[1].length < end)) {
      const position = shortenedStart[1].length;
      shortened = shortened.slice(0, position) + shortened[position].toUpperCase() + shortened.slice(position + 1);
    }
    // Capitalise sentences after shortening, not words following abbreviations.
    // Match the export formatter; protected URLs, emails and filenames stay exact.
    return shortened.replace(/\.(["'\u2019\u201d)\]]*\s+["'\u2018\u201c(\[]*)([a-z])/g, (match, gap, letter, offset) => {
      const position = offset + 1 + gap.length;
      if (protectedRanges.some(([start, end]) => start <= position && position < end)
          || /\b(?:min|max|incl|approx|figs?|sec|no|vs|etc|e\.g|i\.e)\.$/i.test(shortened.slice(Math.max(0, offset - 12), offset + 1))) return match;
      return `.${gap}${letter.toUpperCase()}`;
    });
  }

  const selectorRecord = record => /^(?:promat-|trafalgar-selector-)/i.test(String(record?.id || ""));
  function displayTitle(record) {
    const title = String(record?.title || record?.id || "");
    // Only supplier selector numbers are presentation noise. Technical IDs,
    // dimensions and ratings remain literal, and navigation keeps record.id.
    return selectorRecord(record) ? title.replace(/^\s*(Promat|Trafalgar)(?:\s*:\s*|\s+)\d+\s*[—–-]\s*/i, "$1 — ") : title;
  }
  function displaySubtitle(record) {
    const subtitle = String(record?.subtitle || "");
    return selectorRecord(record) ? subtitle.split("·").map(part => part.trim())
      .filter(part => part && !/^\d+\s+selector variants?$/i.test(part)).join(" · ") : subtitle;
  }
  const hiddenFields = new Set(["diagram captions (visually checked)", "workbook report revision", "reference review", "reference qualification", "workbook / source differences", "workbook / source difference", "source information"]);
  const hiddenTechnicalFields = new Set(["source table notes", "source option alignment", "technical basis", "lead time"]);
  function visibleField(record, field, kind = "technical") {
    const label = String(field.label || "").trim().toLowerCase();
    if (hiddenFields.has(label) || kind === "technical" && hiddenTechnicalFields.has(label)) return false;
    const selectorSupplier = selectorRecord(record) || (record.fields || []).some(item =>
      String(item.label).trim().toLowerCase() === "manufacturer" && String(item.value).split(/\r?\n/)
        .some(name => /^(?:promat|trafalgar)$/i.test(name.trim())));
    if (kind === "technical" && selectorSupplier && label === "id" &&
        /^(?:\d+|sys_var_\d+_au)(?:\s*\(\+\d+ variants listed below\))?$/i.test(String(field.value).trim())) return false;
    return kind !== "technical" || String(field.value ?? "").trim() !== "" || Boolean(field.images?.length || field.table || field.tables?.length || field.table_links?.length);
  }

  function installationHeading(lines, index) {
    if (!/^Installation (?:through|against)\b/.test(lines[index] || "")) return null;
    let text = "";
    for (let end = index; end < Math.min(lines.length, index + 4); end += 1) {
      if (!lines[end] || marker(lines[end])) return null;
      text = join(text, lines[end]);
      if (/[–—]$/.test(text)) {
        const next = lines.slice(end + 1).find(line => line);
        return marker(next || "")?.ordered ? { text, end } : null;
      }
    }
    return null;
  }

  function marker(line, listContext = false, sourceMarkers = false) {
    // Imported lists can add an outer number to an existing report label.
    // Prefer that explicit label without changing the stored source text.
    if (sourceMarkers) {
      const labelled = /^(?:\d+[.)]\s+)?(\([A-Z]\)|[A-Z]\)|\([1-9]\d?\)|[1-9]\d?\))\s+(.+)$/.exec(line);
      if (labelled) return { ordered: true, number: null, label: labelled[1], text: labelled[2] };
    }
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

  function parse(value, { sourceMarkers = false } = {}) {
    const lines = String(value ?? "").replace(/\r\n?|[\f\u2028\u2029]/g, "\n").split("\n").map(cleanLine);
    const blocks = [];
    let paragraph = null, list = null, item = null, nested = null, nestedItem = null, gap = false;
    const end = () => { paragraph = null; list = null; item = null; nested = null; nestedItem = null; gap = false; };
    const addParagraph = text => { paragraph = { type: "paragraph", text }; blocks.push(paragraph); };
    const addItem = (target, found) => {
      const result = { text: found.text, children: [] };
      if (found.ordered) result.number = found.number;
      if (found.label) result.label = found.label;
      target.items.push(result);
      return result;
    };

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (!line) { gap = true; continue; }
      if (sourcePage.test(line)) { end(); continue; }
      // These source headings separate alternative procedures. Their trailing
      // dash and following numbered step distinguish them from wrapped prose.
      const section = installationHeading(lines, index);
      if (section) { end(); addParagraph(section.text); index = section.end; end(); continue; }
      if (/^With\b/.test(line) && installationHeading(lines, index + 1)) { end(); addParagraph(line); end(); continue; }
      if (/^Notes?:\s+\S/i.test(line)) { end(); addParagraph(line); continue; }
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
      const found = marker(line, Boolean(nested || list && !list.ordered || /:$/.test((item || paragraph)?.text || "")), sourceMarkers);
      if (found) {
        paragraph = null;
        if (!found.ordered && list?.ordered && item && (nested || /:$/.test(item.text))) {
          if (!nested) { nested = { type: "list", ordered: false, items: [] }; item.children.push(nested); }
          nestedItem = addItem(nested, found);
        } else {
          // Numbering resets represent a new list; gaps/skipped numbers retain
          // their explicit values so a source step is never silently renumbered.
          if (!list || list.ordered !== found.ordered || Boolean(found.label) !== Boolean(item?.label) || found.ordered && found.number !== null && found.number <= item.number) {
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
      if (longHeading(line) && (!current || /[.!?]$/.test(current.text))) { end(); addParagraph(line); continue; }
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
      else if (paragraph && !heading(paragraph.text) && !longHeading(paragraph.text)) paragraph.text = join(paragraph.text, line);
      else addParagraph(line);
      gap = false;
    }
    return blocks;
  }

  function render(document, value, options) {
    const display = options?.compact ? compact : text => text;
    const renderBlock = block => {
      if (block.type === "paragraph") {
        const paragraph = document.createElement("p"); paragraph.textContent = display(block.text); return paragraph;
      }
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.items[0].label) list.className = "library-source-labelled-list";
      else if (block.ordered && block.items[0].number !== 1) list.setAttribute("start", String(block.items[0].number));
      for (const item of block.items) {
        const element = document.createElement("li");
        if (item.label) element.setAttribute("data-source-marker", item.label);
        else if (block.ordered) element.setAttribute("value", String(item.number));
        // Number markers are rendered by <ol>, but their full stop still starts
        // a sentence. Keep that context for the shared display/export rule.
        const prefix = options?.compact && block.ordered && !item.label ? `${item.number}. ` : "";
        element.textContent = display(prefix + item.text).slice(prefix.length);
        element.append(...item.children.map(renderBlock));
        list.append(element);
      }
      return list;
    };
    return parse(value, options).map(renderBlock);
  }

  const api = Object.freeze({ parse, render, compact, displayTitle, displaySubtitle, visibleField });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LibraryDetailText = api;
})(typeof window !== "undefined" ? window : globalThis);
