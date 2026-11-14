"use strict";

// HEADER_TAGLINE:START
// Presentation only: selecting and typing a phrase never changes a project.
(() => {
  const label = document.getElementById("header-tagline-label");
  const sizer = document.getElementById("header-tagline-sizer");
  const typed = document.getElementById("header-tagline-typed");
  const cursor = document.querySelector("#header-tagline .header-tagline-cursor");
  if (!label || !sizer || !typed || !cursor) return;
  const phrases = [
    "Built on caffeine and the audacity of 'Do your best, mastic the rest.'",
    "Made for deadlines and the belief that 'There’s a tested system for that… probably.'",
    "I'm an expert at reading plans and looking at photos - a site visit would just be a waste of my time.",
    "Every penetration has a story, and most of them end in mastic.",
    "The tested detail looked great right up until installation.",
    "Some call it non-compliant; we call it 'pending clarification.'",
    "Every defect starts with 'It was like that when we got here.'",
    "The wall was fire-rated before the services arrived.",
    "Built to the drawing, adjusted to reality.",
    "The services were coordinated perfectly, just not with the wall.",
    "Behind every neat firestop is an opening that nearly ruined someone’s day.",
    "A tested system exists for everything except what we found on site.",
    "Measure twice, discover the drawing is wrong anyway.",
    "The architect drew the wall; the services drew their own conclusions.",
    "The drawing said “typical,” which was optimistic.",
    "Fire testing proves the system works; construction proves how creative people can be.",
    "The installation was executed flawlessly with no delays, coordination issues or late payment. Then we wrote the test report.",
    "Give me a Red Bull and a cigarette and I could probably spray that.",
    "The defect was minor until someone photographed it.",
    "I like to think that Penetration Specialist is code for Gigolo.",
    "The system performs impeccably in ideal conditions - a fire test laboratory.",
    "The fire will be outsmarted by the concession in our performance solution.",
    "The building is now protected by a robust layer of professional opinion.",
    "The fire engineer has reviewed the issue and the fire is expected to cooperate.",
    "Any future flames should refer to the approved performance solution before proceeding.",
    "The defect is now compliant with the broader intent of everyone wanting to move on.",
    "The risk is tolerable, particularly from the office.",
    "The opening has achieved compliance through superior documentation.",
    "I don’t believe in common sense unless it has a report number.",
    "I’ll believe it when someone with letters after their name puts it in writing.",
    "I don’t need proof; I need a well-crafted paragraph that sounds like proof.",
    "Experience is useful, but have you considered getting an engineer to say the same thing?",
    "Every project has the same deadline, which was yesterday.",
    "The customer is always right, particularly when it comes to an expensive variation.",
    "I trust the laws of physics, but I’d still like that confirmed in writing.",
    "Sun Tzu said: the strongest defence is a professionally worded opinion.",
    "Explaining my job takes longer than just letting people think I’m a firefighter.",
    "I don’t run into burning buildings, but I do complain about the holes in them beforehand.",
    "I’m not a firefighter, but I do spend a suspicious amount of time talking about fire.",
    "Just think of it like insurance, except it only lasts for 120 minutes.",
    "I don't need a depth gauge when I have a perfectly good set of eyes.",
    "Proper Preparation Prevents Piss-Poor Performance",
    "Talk FRL to me.",
    "Let me fill your holes.",
    "I know my way around an opening.",
    "Looks aren’t everything. Size matters.",
    "Stop staring at my calculations.",
    "Ridiculously good at looking things up.",
    "“By others” is the hardest-working subcontractor on the project.",
    "No allowances have been made for an archaeological expedition through the ceiling.",
    "Spray is measured in millimetres. Overspray is measured in emails.",
    "Depth. Thickness. Compatibility. I have standards.",
    "Looking for something long-term. Minimum 120 minutes.",
    "Let me help you spray your load.",
    "CLASSIFIRE: Passive Fire Intelligence",
  ];
  const intelligencePhrase = "CLASSIFIRE: Passive Fire Intelligence";
  const scrambleAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=?";
  const taglineNow = () => typeof performance === "object" ? performance.now() : Date.now();
  // The brand line stays literal, like the matching website lockup.
  const phraseText = value => value === intelligencePhrase ? value : window.CeasefireI18n.translate(value);
  const storageKey = "ceasefire.headerTagline.last";
  let previous;
  try { previous = window.localStorage.getItem(storageKey); } catch { /* Storage may be unavailable. */ }
  // All phrases share one hidden grid cell, reserving the tallest wrapping at
  // this width before typing or navigation can change the visible sentence.
  function sizePhrases() {
    sizer.replaceChildren(...phrases.map(phrase => { const line = document.createElement("span"); line.textContent = phraseText(phrase) + "_"; return line; }));
  }
  sizePhrases();
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let phrase = "", displayedPhrase = "", characters = [], typingTimer = null, cursorTimer = null, count = 0, complete = false, closed = false, scrambleStarted = 0;
  let intelligenceAudio = null, soundGeneration = 0;
  try {
    if (typeof window.Audio === "function") {
      intelligenceAudio = new window.Audio(); intelligenceAudio.preload = "auto";
      intelligenceAudio.src = "/sounds/classifire.mp3"; intelligenceAudio.load();
    }
  } catch { /* Optional sound never affects the header. */ }
  function stopIntelligenceSound() {
    ++soundGeneration;
    try { intelligenceAudio?.pause(); if (intelligenceAudio) intelligenceAudio.currentTime = 0; } catch { /* Media can be unavailable. */ }
  }
  function playIntelligenceSound() {
    if (!intelligenceAudio || closed || document.hidden || window.CeasefireAudioSettings?.isEnabled() === false) return;
    const attempt = ++soundGeneration;
    try {
      // One attempt for this appearance. Never retry a blocked clip after a
      // later gesture or readiness event from a different phrase.
      intelligenceAudio.play()?.catch?.(() => { if (attempt === soundGeneration) stopIntelligenceSound(); });
    } catch { if (attempt === soundGeneration) stopIntelligenceSound(); }
  }
  const unsubscribeAudio = window.CeasefireAudioSettings?.subscribe(enabled => { if (!enabled) stopIntelligenceSound(); });
  function stopCursor() {
    clearTimeout(cursorTimer);
    cursorTimer = null;
    cursor.hidden = true;
  }
  function finish() {
    if (closed || motion?.matches || (phrase === intelligencePhrase && document.hidden)) window.CeasefireHeaderTaglineMedia?.stop();
    else if (!complete) window.CeasefireHeaderTaglineMedia?.finish();
    clearTimeout(typingTimer);
    typingTimer = null;
    if (typed.textContent !== displayedPhrase) typed.textContent = displayedPhrase;
    if (complete || closed) return;
    complete = true;
    stopCursor();
  }
  function typeNext() {
    if (closed) return;
    typed.textContent = characters.slice(0, ++count).join("");
    if (count < characters.length) typingTimer = setTimeout(typeNext, 35);
    else finish();
  }
  function scrambleNext() {
    if (closed || complete) return;
    if (motion?.matches || document.hidden) { finish(); return; }
    const elapsed = taglineNow() - scrambleStarted;
    if (elapsed >= 5000) { finish(); return; }
    // Match the website: all words scramble for three seconds, then resolve
    // left to right over two seconds. Keep word spaces and character count.
    const resolved = Math.max(0, (elapsed - 3000) / 2000) * characters.length;
    typed.textContent = characters.map((character, index) => character === " " || index < resolved
      ? character : scrambleAlphabet[Math.floor(Math.random() * scrambleAlphabet.length)]).join("");
    typingTimer = setTimeout(scrambleNext, 55);
  }
  function close() {
    stopIntelligenceSound();
    unsubscribeAudio?.();
    window.CeasefireHeaderTaglineMedia?.close();
    closed = true;
    finish();
    stopCursor();
  }
  function nextPhrase() {
    if (closed) return;
    clearTimeout(typingTimer);
    typingTimer = null;
    stopIntelligenceSound();
    stopCursor();
    const choices = phrases.filter(choice => choice !== (phrase || previous));
    phrase = choices[Math.floor(Math.random() * choices.length)];
    try { window.localStorage.setItem(storageKey, phrase); } catch { /* The phrase still works without storage. */ }
    displayPhrase(true);
  }
  function displayPhrase(newAppearance = false) {
    clearTimeout(typingTimer); typingTimer = null; stopCursor();
    displayedPhrase = phraseText(phrase);
    label.textContent = displayedPhrase;
    characters = Array.from(displayedPhrase); count = 0; complete = false;
    typed.textContent = ""; cursor.hidden = false;
    if (phrase === intelligencePhrase) {
      if (newAppearance) playIntelligenceSound();
      if (motion?.matches || document.hidden) finish();
      else { window.CeasefireHeaderTaglineMedia?.start(); scrambleStarted = taglineNow(); scrambleNext(); }
    } else if (motion?.matches) finish(); else { window.CeasefireHeaderTaglineMedia?.start(); typeNext(); }
  }
  nextPhrase();
  window.addEventListener("ceasefire:languagechange", () => { sizePhrases(); if (!closed) displayPhrase(); });
  window.CeasefireHeaderTagline = Object.freeze({ next: nextPhrase });
  motion?.addEventListener?.("change", event => { if (event.matches) finish(); });
  document.addEventListener?.("visibilitychange", () => {
    if (document.hidden && phrase === intelligencePhrase) { stopIntelligenceSound(); finish(); }
  });
  window.addEventListener?.("pagehide", close, { once: true });
})();
// HEADER_TAGLINE:END

(() => {
  const brand = document.querySelector(".app-header .brand");
  const credit = document.getElementById("brand-credit");
  const phrase = document.getElementById("brand-credit-description")?.textContent;
  if (!brand || !credit || !phrase) return;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const alphabet = "0123456789@#$%&*+=?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const step = 58, hold = 1600, reveal = phrase.length * step;
  let timer;
  function clear() {
    clearTimeout(timer);
    credit.textContent = "";
  }
  function play() {
    clear();
    if (motion.matches) {
      credit.textContent = phrase;
      timer = setTimeout(clear, hold);
      return;
    }
    const start = performance.now();
    function frame() {
      const elapsed = performance.now() - start;
      if (elapsed >= 2 * reveal + hold) { clear(); return; }
      if (elapsed >= reveal && elapsed < reveal + hold) {
        credit.textContent = phrase;
        timer = setTimeout(frame, reveal + hold - elapsed);
        return;
      }
      const forward = elapsed < reveal;
      const resolved = forward ? Math.floor(elapsed / step)
        : phrase.length - 1 - Math.floor((elapsed - reveal - hold) / step);
      const visible = Math.min(phrase.length, resolved + 3);
      let value = phrase.slice(0, resolved);
      for (let i = resolved; i < visible; i++) {
        value += phrase[i] === " " ? " " : alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      credit.textContent = value;
      timer = setTimeout(frame, step);
    }
    frame();
  }
  brand.addEventListener("click", play);
  motion.addEventListener("change", () => { if (motion.matches && credit.textContent) play(); });
  window.addEventListener("pagehide", clear);
})();

(() => {
  const $ = (id) => document.getElementById(id);
  const calculationQueue = window.CeasefireCalculationQueue.create();
  const state = {
    fields: [], currentFields: [], inputs: {}, catalog: { inventory: [], rate_groups: {} }, baseline: { inventory: [], rate_groups: {} },
    configuration: { inventory: {}, rates: {} }, draft: { inventory: {}, rates: {} },
    quote: null, quoteConfiguration: null, quoteContext: 0, quoteLoadRevision: 0, dirty: false, pricingDirty: false,
    result: null, revision: 0, timer: null, pricingExpanded: new Set(), mainSection: "access-travel", mainOutputSection: "material-breakdown", legacyTitle: "",
    workflow: "", defaultWorkflow: "Intumescent spray to ductwork", inputErrors: new Map(), inputDrafts: new Map(), inputRevision: 0, projectBusy: false,
    pricingScope: "library", libraryDraft: null, projectPricingDraft: null, pricingRevision: 0,
    projectFile: null, projectEstimates: [{id:"estimate-1", name:"Estimate 1"}], activeEstimateId: "estimate-1", estimatesDirty: false, projectStatus: "New", projectCards: [], projectsRevision: 0, initialized: false, currentView: "home", lastProjectSection: null, lastDocumentSection: null, projectsOffset: 0, projectsTimer: null, desktopRequests: 0,
    projectBrowserProject: null, projectBrowserPath: "", projectBrowserRevision: 0,
    pricingRender: null, estimatorKind: "estimate", calculatorKind: "penetration", libraryKind: "pricing",
    workItems: [], workItemErrors: new Map(), workItemDrafts: new Map(), nextWorkItem: 1,
    pricingUsage: { firestopping: { label: "Firestopping Estimator", keywords: [], groups: [] } }, takeoffsEnabled: true,
  };
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const quantity = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const controlNumber = new Intl.NumberFormat("en-AU", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percentCells = new Set(["B9", "B26", "B27", ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const wholeCells = new Set(["B4", "B8", "B9", "B26", "B27", "F27", "F28", ...Array.from({ length: 9 }, (_, i) => `B${i + 15}`), ...Array.from({ length: 9 }, (_, i) => `E${i + 15}`)]);
  const materialNames = [
    ["Spraying", "Bags / drums / rolls"], ["Meshing", "m²"], ["Pins / clips", "m²"],
    ["Access panels", "Number of panels"], ["PromaMesh / fan enclosures", "m²"],
    ["Primer", "m²"], ["Topcoat", "m²"], ["Board", "m²"], ["Mastic", "Linear metres"],
  ];
  const coverageTeams = { B15: "D2", B16: "D3", B18: "D6", B19: "D8", B20: "D4", B21: "D5", B22: "D9", B23: "D10" };
  const materialTeams = { 15: "D2", 16: "D3", 17: "D3", 18: "D6", 19: "D8", 20: "D4", 21: "D5", 22: "D9", 23: "D10" };
  const groups = {
    access_hire: "Access hire", labour_rates: "Labour", masking_rates: "Masking",
    freight_rates: "Freight", LAFHA_rates: "Accommodation", travel_rates: "Travel",
    access_panels: "Access panels", mesh: "Mesh", pins: "Pins / clips", sprays: "Sprays",
    boards: "Boards", mastic: "Mastic", primers: "Primers", topcoats: "Topcoats",
  };
  const pricingUnsavedPrompt = "The Pricing Library has unsaved changes. Are you sure you want to continue?";
  const takeoffContents = () => state.takeoffsEnabled ? "takeoff drawings and registers, " : "";
  const pricingSavePrompt = "The changes in this Pricing Library will be saved for future projects. Are you sure you want to save?";
  const additionLabels = {
    E26: "Extra days · labour team", F26: "Extra labour days",
    E27: "Site mobilisation fee", F27: "Mobilisation count",
    E28: "Administration fee", F28: "Administration count",
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const formatNumber = (value) => isNumber(value) ? quantity.format(value) : value === "N/A" ? value : "—";
  const formatMoney = (value) => isNumber(value) ? money.format(value) : "—";
  const displaysZero = (value, formatter) => isNumber(value) && formatter.format(Math.abs(value)) === formatter.format(0);
  const fieldByCell = (cell) => state.fields.find((field) => field.cell === cell);

  const projectDetailControls = {project_no:"project-no", client:"client", site_address:"site-address", contact_name:"project-contact-name", contact_phone:"project-contact-phone", contact_email:"project-contact-email", account_id:"project-account-id", contact_id:"project-contact-id", billing_address:"project-billing-address", abn_acn:"project-abn-acn"};
  function followUpFields(values = {}) {
    const actions = values.actions?.length || values.next_action || values.follow_up_date ? window.ClassifireFollowUpActions.rows(values) : [];
    return {actions, ...(values.history?.length ? {history:values.history} : {})};
  }
  function splitProjectDetails({follow_up_actions:actions, next_action, follow_up_date, ...identity}) {
    return {identity, followUp:followUpFields({actions, next_action, follow_up_date})};
  }
  let projectFollowUp = followUpFields();
  let savedProjectFollowUp = projectFollowUp;
  function quoteDetails() {
    return Object.fromEntries(Object.entries(projectDetailControls).map(([key, id]) => [key, $(id).value.trim()]));
  }
  function applyQuoteDetails(details = {}) {
    for (const [key, id] of Object.entries(projectDetailControls)) $(id).value = details[key] || "";
  }

  function updateQuoteTitle() {
    const details = quoteDetails();
    $("quote-title").value = [details.project_no, details.client, details.site_address.replace(/\s+/g," ")].filter(Boolean).join("- ") || state.legacyTitle || "Untitled quote";
    $("project-name").textContent = $("quote-title").value;
  }

  function controlValue(value, percent = false) {
    return isNumber(value) ? controlNumber.format(Number(percent ? shiftDecimal(value, 2) : value)) : value ?? "";
  }

  function editedNumber(control, percent = false) {
    if (control.validity.badInput) return "Invalid number";
    if (control.value === "") return "";
    const numeric = Number(control.value);
    if (!Number.isFinite(numeric)) return "Invalid number";
    const displayed = controlNumber.format(numeric);
    // Untouched imported values remain full precision in state. An intentional
    // edit is limited to the two decimal places the estimator can see.
    if (Number(displayed) !== numeric) control.value = displayed;
    return Number(percent ? shiftDecimal(displayed, -2) : displayed);
  }

  function estimateControlValue(field, value) {
    if (field.cell === "B28") return isNumber(value) ? money.format(value) : value ?? "";
    // Existing fractional snapshots stay visible and exact until deliberately edited.
    if (wholeCells.has(field.cell)) return isNumber(value) ? String(isPercent(field) ? shiftDecimal(value, 2) : value) : value ?? "";
    return controlValue(value, isPercent(field));
  }

  function editedEstimateNumber(control, field) {
    if (field.cell === "B28") {
      const raw = control.value.trim().replace(/^(-?)\$\s*/, "$1").replace(/,/g, "");
      if (!raw) return "";
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw))) return "Invalid currency amount";
      return Number(controlNumber.format(Number(raw)));
    }
    if (wholeCells.has(field.cell)) {
      if (control.validity.badInput || control.value !== "" && !Number.isInteger(Number(control.value))) return "Enter a whole number with no decimal places";
      return control.value === "" ? "" : Number(isPercent(field) ? shiftDecimal(control.value, -2) : control.value);
    }
    return editedNumber(control, isPercent(field));
  }

  function coverageNeedsTeam(cell, item) {
    const team = coverageTeams[cell]; if (!team) return false;
    const row = cell.slice(1);
    const getInput = column => item ? item.inputs[column] :
      Object.hasOwn(state.inputs, column + row) ? state.inputs[column + row] : fieldByCell(column + row)?.default;
    const output = getInput("C"), product = String(getInput("D") ?? "").trim();
    if (output == null || output === "" || output === 0 || !product || product.toLowerCase() === "n/a") return false;
    const value = Object.hasOwn(state.inputs, team) ? state.inputs[team] : fieldByCell(team)?.default;
    return value === null || value === "" || typeof value === "string" && value.toLowerCase() === "n/a";
  }

  function validateCoverageTeams() {
    for (const cell of Object.keys(coverageTeams)) {
      const value = Object.hasOwn(state.inputs, cell) ? state.inputs[cell] : fieldByCell(cell)?.default;
      const blocked = isNumber(value) && value !== 0 && coverageNeedsTeam(cell);
      if (blocked && !state.inputDrafts.has(cell)) state.inputErrors.set(cell, "Select Teams");
      else if (!blocked && state.inputErrors.get(cell) === "Select Teams") state.inputErrors.delete(cell);
      const control = $(`input-${cell}`), error = state.inputErrors.get(cell);
      if (error) control?.setAttribute("aria-invalid", "true"); else control?.removeAttribute("aria-invalid");
      control?.setCustomValidity?.(error || "");
    }
    for (const item of state.workItems) {
      const key = `${item.id}:B`, value = item.inputs.B;
      const blocked = isNumber(value) && value !== 0 && coverageNeedsTeam(`B${item.source_row}`, item);
      if (blocked && !state.workItemDrafts.has(key)) state.workItemErrors.set(key, "Select Teams");
      else if (!blocked && state.workItemErrors.get(key) === "Select Teams") state.workItemErrors.delete(key);
      const control = $(`work-item-${item.id}-B`), error = state.workItemErrors.get(key);
      if (error) control?.setAttribute("aria-invalid", "true"); else control?.removeAttribute("aria-invalid");
      control?.setCustomValidity?.(error || "");
    }
  }

  function updateMaterialRowVisibility() {
    for (const row of $("material-inputs").children) {
      const team = materialTeams[Number(row.dataset.materialRow)];
      const value = Object.hasOwn(state.inputs, team) ? state.inputs[team] : fieldByCell(team)?.default;
      row.hidden = typeof value === "string" && value.trim().toLowerCase() === "n/a";
    }
  }

  function inputProblem() { validateCoverageTeams(); return [...state.inputErrors.values(), ...state.workItemErrors.values()][0] || window.CeasefirePenetrations?.scheduleProblem?.() || ""; }

  function showInputProblems() {
    clearResults("Check inputs");
    const box = $("calculation-errors"); box.textContent = [...state.inputErrors.values(), ...state.workItemErrors.values(), window.CeasefirePenetrations?.scheduleProblem?.()].filter(Boolean).join("\n"); box.hidden = false;
    for (const cell of state.inputErrors.keys()) $(`input-${cell}`)?.setAttribute("aria-invalid", "true");
  }

  // Move the decimal point in its text representation, retaining all entered digits.
  function shiftDecimal(value, places) {
    const match = String(value).match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return String(value);
    const digits = (match[2] || "") + (match[3] || "");
    const position = (match[2] || "").length + Number(match[4] || 0) + places;
    if (position <= 0) return `${match[1]}0.${"0".repeat(-position)}${digits}`;
    if (position >= digits.length) return `${match[1]}${digits}${"0".repeat(position - digits.length)}`.replace(/^([+-]?)0+(?=\d)/, "$1");
    return `${match[1]}${digits.slice(0, position)}.${digits.slice(position)}`.replace(/^([+-]?)0+(?=\d)/, "$1");
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  // Only application-owned copy is bound. User values, product names and
  // retained source evidence continue through node() without translation.
  function uiNode(tag, className, source, args = []) {
    return window.CeasefireI18n.nodeText(node(tag, className), source, args);
  }
  function uiCopy(source, args = []) { return source === "" ? "" : { i18nSource: source, i18nArgs: args }; }
  function uiText(element, copy) {
    if (copy && typeof copy === "object" && Object.hasOwn(copy, "i18nSource")) return window.CeasefireI18n.text(element, copy.i18nSource, copy.i18nArgs);
    if (copy && typeof copy === "object") return window.CeasefireI18n.text(element, "{0}", [copy]);
    return window.CeasefireI18n.text(element, copy == null ? "" : String(copy));
  }

  function releaseMessageSpace() {
    const slot = $("app-message-slot");
    if (slot?.style) slot.style.minHeight = "";
  }
  function retireMessage() {
    const box = $("app-message");
    if (box.hidden) return;
    const slot = $("app-message-slot"), height = slot?.getBoundingClientRect?.().height;
    if (slot?.style && Number.isFinite(height) && height > 0) slot.style.minHeight = `${height}px`;
    box.hidden = true;
  }
  function message(text, error = false, kind = null) {
    releaseMessageSpace();
    const box = $("app-message");
    uiText(box, text);
    box.className = `message${error ? " error" : ""}`;
    box.hidden = !text;
    box.setAttribute("role", error ? "alert" : "status");
    state.projectSavedNotice = kind === "project-saved" ? window.CeasefireI18n.source(box) : null;
    window.CeasefireNotifications?.show(box);
  }

  async function request(path, options = {}) {
    const endActivity = window.CeasefireActivity?.begin();
    try {
    state.desktopRequests++;
    try {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const detail = data.error || data.message || `Request failed (${response.status}).`;
      const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      error.status = response.status; throw error;
    }
    return data;
    } finally { state.desktopRequests--; }
    } finally { endActivity?.(); }
  }

  function updateDirty(value = true) {
    state.dirty = value;
    window.CeasefireI18n.text($("quote-status"), "{0}{1}", [window.CeasefireI18n.term(state.projectFile ? "Project file" : state.quote ? "Older saved estimate" : "New project"), window.CeasefireI18n.term(value ? " · Unsaved changes" : "")]);
    updateProjectStatus();
  }

  const projectStatuses = ["New", "Quote", "Engage", "Won", "Lost"];
  const projectColumnsKey = "classifire.projectBoard.hiddenStages.v1";
  const hiddenProjectStages = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(projectColumnsKey));
    if (Array.isArray(stored)) {
      for (const stage of projectStatuses) if (stored.includes(stage)) hiddenProjectStages.add(stage);
    }
  } catch { /* The board remains usable when preferences are unavailable. */ }
  const projectPages = $("project-pages");
  const documentPages = $("document-pages");

  // Move the real headings, including their controls, rather than copying them.
  // Their IDs, pending operations and event listeners keep the same owners.
  function refreshWorkspaceHeading(kind, selection) {
    const section = $("view-" + kind), tabs = $(kind === "calculators" ? "calculator-kind-pages" : "library-pages");
    if (!section || !tabs) return;
    let slot = $(kind + "-heading-slot");
    if (!slot) {
      slot = document.createElement("div"); slot.id = kind + "-heading-slot"; slot.className = "workspace-section-heading";
      section.insertBefore(slot, tabs);
    }
    if (kind === "calculators") {
      for (const [selector, visible] of [[".calculator-workspace-heading", selection !== "penetration"], [".penetration-banner-heading", selection === "penetration"]]) {
        const heading = section.querySelector(selector);
        if (heading) { heading.classList.add("workspace-title-row"); slot.append(heading); heading.hidden = !visible; }
      }
    } else {
      for (const name of ["pricing", "penetration", "technical"]) {
        const heading = section.querySelector(`#library-${name} > .page-heading`) || slot.querySelector(`[data-library-heading="${name}"]`);
        if (heading) { heading.classList.add("workspace-title-row"); heading.dataset.libraryHeading = name; slot.append(heading); heading.hidden = name !== selection; }
      }
    }
  }

  function refreshProjectPages() {
    const active = ["quotes", "quote", "work-orders", "purchase-orders"].includes(state.currentView);
    if (!projectPages) return;
    projectPages.hidden = !active;
    if (!active) return;
    const section = $("view-" + state.currentView), heading = section?.querySelector(".page-heading");
    // Keep one navigation element through commercial list/editor rebuilds.
    if (heading?.parentNode) heading.parentNode.insertBefore(projectPages, heading.nextSibling);
    else section?.insertBefore?.(projectPages, section.firstChild);
    for (const button of projectPages.querySelectorAll("[data-project-section]")) {
      const selected = button.dataset.projectSection === state.currentView;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
  }

  function refreshDocumentPages() {
    if (!documentPages) return;
    const active = ["documentation", "swms", "certification", "passive-fire-register"].includes(state.currentView);
    documentPages.hidden = !active;
    if (!active) return;
    const section = $("view-" + state.currentView), heading = section?.querySelector(":scope > .page-heading");
    // SWMS rebuilds its root when opening a statement. Keep the Documentation
    // return button outside that root through list and editor rendering.
    if (heading?.parentNode) heading.parentNode.insertBefore(documentPages, heading.nextSibling);
    else section?.insertBefore?.(documentPages, section.firstChild);
    for (const button of documentPages.querySelectorAll("[data-document-section]")) {
      const selected = button.dataset.documentSection === state.currentView;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
  }

  function updateProjectPricingContext() {
    const label = $("project-pricing-context");
    if (!label) return;
    // The metadata pane may inspect a different saved file. Pricing always
    // belongs to the loaded workspace, whose identity lives in projectFile.
    label.textContent = state.projectFile?.title || $("quote-title").value;
  }

  function updateProjectStatus() {
    renderEstimateControls();
    updateProjectPricingContext();
    const file = state.projectFile, changed = !!projectHasChanges();
    // A fresh draft updates the save badge; notices remain until dismissal/navigation.
    if (changed && state.projectSavedNotice) {
      state.projectSavedNotice = null;
    }
    const status = $("project-save-state");
    window.CeasefireI18n.text(status, state.projectBusy ? "Working…" : changed ? "Unsaved changes" : file ? "Saved project" : "Not saved to a file");
    status.classList.toggle("unsaved", changed || !file);
    const projectName = $("header-project-name");
    if (projectName) {
      const title = typeof file?.title === "string" ? file.title.trim() : "";
      projectName.classList.toggle("header-projects-link", !title);
      if (title) {
        window.CeasefireI18n.text(projectName, "{0}", [title]);
        window.CeasefireI18n.attr(projectName, "title", "{0}", [title]);
      } else {
        window.CeasefireI18n.text(projectName, "Projects");
        window.CeasefireI18n.attr(projectName, "title", "Projects");
      }
      projectName.disabled = state.projectBusy;
    }
    if (file?.path || file?.relative_path) $("project-file-location").textContent = file.path || file.relative_path;
    else window.CeasefireI18n.text($("project-file-location"), file ? "Imported file · choose a folder with Save" : "Choose a folder with Save");
    const savedAt = file?.modified_at ? new Date(file.modified_at) : null;
    if (savedAt && !Number.isNaN(savedAt.getTime())) window.CeasefireI18n.text($("project-last-saved"), "File saved {0}", [savedAt.toLocaleString("en-AU")]);
    else window.CeasefireI18n.text($("project-last-saved"), "File save time unavailable");
    $("project-last-saved").hidden = !file;
    window.CeasefireI18n.text($("project-pricing-source"), state.quoteConfiguration ? "Pricing: project snapshot" : "Pricing: current saved library");
  }

  function isPercent(field) {
    return percentCells.has(field.cell) || (field.format || "").includes("%");
  }

  function makeControl(field, compact = false) {
    let control;
    if (field.type === "select" || Array.isArray(field.options)) {
      control = node("select");
      const current = String(state.inputs[field.cell] ?? "");
      // A saved empty workbook value is displayed as N/A without rewriting
      // historical inputs or introducing an unsupported calculation value.
      const supplied = (field.options || []).map(String);
      const unavailable = current === "N/A" || current !== "" && supplied.includes("N/A") ? "N/A" : "";
      const options = [unavailable, ...supplied.filter(option => option !== "" && option !== "N/A")];
      if (!options.includes(current)) options.unshift(current);
      for (const value of options) {
        const label = Object.hasOwn(field.option_labels || {}, value) ? field.option_labels[value] : value;
        const option = value === unavailable ? uiNode("option", "", "N/A") : node("option", "", label);
        option.value = value;
        control.append(option);
      }
      control.value = current;
    } else if (field.cell === "B12") {
      control = node("textarea");
      control.rows = 2;
      control.value = state.inputs[field.cell] ?? "";
    } else {
      control = node("input");
      control.type = field.type === "number" && field.cell !== "B28" ? "number" : "text";
      const value = state.inputs[field.cell] ?? "";
      control.value = state.inputDrafts.has(field.cell) ? state.inputDrafts.get(field.cell) : estimateControlValue(field, value);
      if (control.type === "number") {
        control.step = wholeCells.has(field.cell) ? "1" : "0.01";
        control.inputMode = wholeCells.has(field.cell) ? "numeric" : "decimal";
      }
      if (field.cell === "B28") control.inputMode = "decimal";
    }
    control.id = `input-${field.cell}`;
    control.dataset.cell = field.cell;
    window.CeasefireI18n.attr(control, "aria-label", "{0}{1}", [window.CeasefireI18n.term(field.label || "Estimate input"), window.CeasefireI18n.term(isPercent(field) ? " in percent" : "")]);
    if (state.inputErrors.has(field.cell)) {
      control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(state.inputErrors.get(field.cell));
    }
    control.addEventListener("input", () => {
      state.inputRevision++;
      let value = control.value;
      if (coverageNeedsTeam(field.cell) && value !== "" && Number.isFinite(Number(value)) && Number(value) !== 0) {
        control.value = state.inputDrafts.has(field.cell) ? state.inputDrafts.get(field.cell) : estimateControlValue(field, state.inputs[field.cell]);
        validateCoverageTeams(); message(uiCopy("Select Teams"), true);
        if (state.inputErrors.size) showInputProblems();
        return;
      }
      if (field.type === "number") value = editedEstimateNumber(control, field);
      if (field.type === "number" && typeof value === "string" && value !== "") {
        state.inputErrors.set(field.cell, `${field.label}: ${value}.`);
        state.inputDrafts.set(field.cell, control.value);
        control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(value);
        updateDirty(); scheduleCalculation(); return;
      }
      state.inputErrors.delete(field.cell); state.inputDrafts.delete(field.cell);
      control.removeAttribute("aria-invalid"); control.setCustomValidity?.("");
      state.inputs[field.cell] = value;
      validateCoverageTeams();
      if (Object.values(materialTeams).includes(field.cell)) updateMaterialRowVisibility();
      if (state.inputErrors.get(Object.keys(coverageTeams).find(cell => coverageTeams[cell] === field.cell)) === "Select Teams") message(uiCopy("Select Teams"), true);
      else if (window.CeasefireI18n.source($("app-message")) === "Select Teams" && ![...state.inputErrors.values()].includes("Select Teams")) message(uiCopy(""));
      updateDirty();
      if (field.cell === "D7") renderInputs();
      scheduleCalculation();
    });
    if (field.type === "number") control.addEventListener("blur", () => {
      if (!state.inputErrors.has(field.cell) && (isNumber(state.inputs[field.cell]) || state.inputs[field.cell] === "")) control.value = estimateControlValue(field, state.inputs[field.cell]);
    });
    if (compact) return control;
    const label = node("label", "field");
    const caption = uiNode("span", "", (field.label || "Estimate input") + (isPercent(field) && !(field.label || "").includes("%") ? " (%)" : ""));
    if (field.cell === "B9") {
      const help = "Masking/cleaning is a percentage of Spray labour.";
      window.CeasefireI18n.attr(caption, "title", help); window.CeasefireI18n.attr(control, "title", help); window.CeasefireI18n.attr(control, "aria-description", help);
    }
    label.append(caption, control);
    return label;
  }

  function workItemKey(item, column) { return `${item.id}:${column}`; }

  function makeWorkItemControl(item, column) {
    const field = fieldByCell(`${column}${item.source_row}`), key = workItemKey(item, column);
    let control;
    if (field.type === "select" || Array.isArray(field.options)) {
      control = node("select");
      const current = String(item.inputs[column] ?? "");
      const supplied = (field.options || []).map(String);
      const unavailable = current === "N/A" || current !== "" && supplied.includes("N/A") ? "N/A" : "";
      const options = [unavailable, ...supplied.filter(option => option !== "" && option !== "N/A")];
      if (!options.includes(current)) options.unshift(current);
      for (const value of options) {
        const option = value === unavailable ? uiNode("option", "", "N/A") : node("option", "", field.option_labels?.[value] ?? value);
        option.value = value; control.append(option);
      }
      control.value = current;
    } else {
      control = node("input"); control.type = "number";
      control.step = wholeCells.has(field.cell) ? "1" : "0.01";
      control.inputMode = wholeCells.has(field.cell) ? "numeric" : "decimal";
      control.value = state.workItemDrafts.has(key) ? state.workItemDrafts.get(key) : estimateControlValue(field, item.inputs[column]);
    }
    control.id = `work-item-${item.id}-${column}`;
    control.dataset.workItem = item.id; control.dataset.sourceRow = String(item.source_row); control.dataset.column = column;
    window.CeasefireI18n.attr(control, "aria-label", "{0} duplicate — {1}", [window.CeasefireI18n.term(materialNames[item.source_row - 15][0]), window.CeasefireI18n.term(field.label || "input")]);
    if (state.workItemErrors.has(key)) { control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(state.workItemErrors.get(key)); }
    control.addEventListener("input", () => {
      state.inputRevision++;
      let value = control.value;
      if (column === "B" && coverageNeedsTeam(`B${item.source_row}`, item) && value !== "" && Number.isFinite(Number(value)) && Number(value) !== 0) {
        control.value = state.workItemDrafts.has(key) ? state.workItemDrafts.get(key) : estimateControlValue(field, item.inputs[column]);
        validateCoverageTeams(); message(uiCopy("Select Teams"), true); showInputProblems(); return;
      }
      if (field.type === "number") value = editedEstimateNumber(control, field);
      if (field.type === "number" && typeof value === "string" && value !== "") {
        state.workItemErrors.set(key, `${field.label}: ${value}.`); state.workItemDrafts.set(key, control.value);
        control.setAttribute("aria-invalid", "true"); control.setCustomValidity?.(value); updateDirty(); scheduleCalculation(); return;
      }
      state.workItemErrors.delete(key); state.workItemDrafts.delete(key);
      control.removeAttribute("aria-invalid"); control.setCustomValidity?.(""); item.inputs[column] = value;
      validateCoverageTeams(); updateDirty(); scheduleCalculation();
    });
    if (field.type === "number") control.addEventListener("blur", () => {
      if (!state.workItemErrors.has(key) && (isNumber(item.inputs[column]) || item.inputs[column] === "")) control.value = estimateControlValue(field, item.inputs[column]);
    });
    return control;
  }

  function addWorkItem(sourceRow, values) {
    let id;
    do { id = `work-${Date.now().toString(36)}-${state.nextWorkItem++}`; } while (state.workItems.some(item => item.id === id));
    state.workItems.push({ id, source_row: sourceRow, inputs: Object.fromEntries(["B", "C", "D", "E"].map(column => [column, clone(values?.[column] ?? state.inputs[`${column}${sourceRow}`] ?? "")])) });
    state.inputRevision++; renderInputs(); updateDirty(); scheduleCalculation();
  }

  function removeWorkItem(item) {
    state.workItems = state.workItems.filter(candidate => candidate.id !== item.id);
    for (const column of ["B", "C", "D", "E"]) { state.workItemErrors.delete(workItemKey(item, column)); state.workItemDrafts.delete(workItemKey(item, column)); }
    state.inputRevision++; renderInputs(); updateDirty(); scheduleCalculation();
  }

  function workItemAction(label, symbol, action, className = "") {
    const button = node("button", `button secondary icon-only work-item-action ${className}`.trim());
    button.type = "button"; if (label?.i18nSource) { window.CeasefireI18n.attr(button, "title", label.i18nSource, label.i18nArgs); window.CeasefireI18n.attr(button, "aria-label", label.i18nSource, label.i18nArgs); }
    const accessibleLabel = node("span", "sr-only"); uiText(accessibleLabel, label);
    const art = symbol ? node("span", "button-symbol", symbol) : node("span", "trash-artwork");
    art.setAttribute("aria-hidden", "true"); button.append(art, accessibleLabel);
    button.addEventListener("click", action); return button;
  }

  function renderMaterialRow(sourceRow, item = null) {
    const tr = node("tr", item ? "duplicated-work-item" : "");
    tr.dataset.materialRow = String(sourceRow); if (item) tr.dataset.workItem = item.id;
    const name = materialNames[sourceRow - 15][0];
    const title = node("td", "material-label"); title.append(uiNode("span", "", name));
    title.append(uiNode("small", "", item ? "Duplicated work item" : materialNames[sourceRow - 15][1])); tr.append(title);
    for (const column of ["B", "C", "D", "E"]) {
      const td = node("td"), field = fieldByCell(`${column}${sourceRow}`);
      const control = field ? (item ? makeWorkItemControl(item, column) : makeControl(field, true)) : node("span", "", "—");
      if (field && (column === "B" || column === "C")) {
        const unit = column === "B" ? materialNames[sourceRow - 15][1] : sourceRow === 17 ? "m²" : "Quantity";
        window.CeasefireI18n.attr(control, "title", unit);
        window.CeasefireI18n.attr(control, "aria-label", "{0}{1} — {2} ({3})", [window.CeasefireI18n.term(name), window.CeasefireI18n.term(item ? " duplicate" : ""), window.CeasefireI18n.term(column === "B" ? "Coverage required" : "Daily output"), window.CeasefireI18n.term(unit)]);
        if (column === "C") window.CeasefireI18n.attr(control, "aria-description", sourceRow === 17 ? "Square metres per day. This field does not change pinning labour, which follows meshing days." : "Quantity of selected product units completed per day.");
      }
      td.append(control); tr.append(td);
    }
    const yieldCell = node("td", "calculated-yield"), value = node("span", "", "—");
    value.id = item ? `yield-work-item-${item.id}` : `yield-${sourceRow}`; yieldCell.append(value); tr.append(yieldCell);
    const actions = node("td", "work-item-actions");
    actions.append(workItemAction(uiCopy("Duplicate {0} work item", [window.CeasefireI18n.term(name)]), "⧉", () => addWorkItem(sourceRow, item?.inputs)));
    if (item) actions.append(workItemAction(uiCopy("Remove {0} duplicated work item", [window.CeasefireI18n.term(name)]), null, () => removeWorkItem(item), "remove-work-item trash-button"));
    tr.append(actions); return tr;
  }

  function inputCard(key, title, fields, helper) {
    if (!fields.length) return null;
    const section = node("section", "card main-section-panel");
    section.dataset.inputSection = key;
    section.dataset.mainSection = key;
    section.id = `main-panel-${key}`;
    const heading = node("div", "section-heading");
    const h2 = uiNode("h2", "", title);
    h2.id = `section-${fields[0].cell}`;
    section.setAttribute("aria-labelledby", h2.id);
    heading.append(h2);
    const fieldGrid = node("div", "fields");
    for (const field of fields) fieldGrid.append(makeControl(field));
    section.append(heading, fieldGrid);
    if (helper) section.append(uiNode("p", "helper", helper));
    return section;
  }

  function mainSectionPanels(group = "input") {
    if (group === "output") return [$("main-panel-material-breakdown"),
      $("main-panel-labour-breakdown"), $("main-panel-firestopping-schedule"),
      $("main-panel-firestopping-breakdown")].filter(section => section?.dataset.mainSection);
    const cards = id => [...$(id).children].filter(section => section.dataset.mainSection);
    return [...cards("input-sections"), $("main-panel-materials"), ...cards("post-material-input-sections"),
      ...cards("adjustment-sections")].filter(section => section?.dataset.mainSection);
  }

  function selectMainSection(key, { focus = false } = {}) {
    // Navigation and calculator transfers can still select any existing section,
    // but each group owns its visibility and selection independently.
    const group = mainSectionPanels("output").some(panel => panel.dataset.mainSection === key) ? "output" : "input";
    const panels = mainSectionPanels(group);
    if (!panels.some(panel => panel.dataset.mainSection === key)) return;
    state[group === "output" ? "mainOutputSection" : "mainSection"] = key;
    for (const panel of panels) panel.hidden = panel.dataset.mainSection !== key;
    for (const tab of $(group === "output" ? "main-output-tabs" : "main-section-tabs").children) {
      const active = tab.dataset.mainSectionTab === key;
      tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
      if (active && focus) { tab.focus(); tab.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }
    }
  }

  function renderMainSectionTabs() {
    const focused = document.activeElement?.dataset?.mainSectionTab;
    for (const group of ["input", "output"]) {
      const panels = mainSectionPanels(group), list = $(group === "output" ? "main-output-tabs" : "main-section-tabs");
      const stateKey = group === "output" ? "mainOutputSection" : "mainSection";
      const tabs = panels.map(panel => {
        const key = panel.dataset.mainSection;
        const title = panel.dataset.mainSectionTitle || window.CeasefireI18n.source(panel.querySelector("h2"));
        const tab = uiNode("button", "main-section-tab", title);
        tab.type = "button"; tab.id = `main-tab-${key}`; tab.dataset.mainSectionTab = key;
        tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", panel.id);
        panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id);
        tab.addEventListener("click", () => selectMainSection(key));
        tab.addEventListener("keydown", event => {
          const index = tabs.indexOf(tab), count = tabs.length;
          const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }[event.key];
          if (next === undefined) return;
          event.preventDefault(); selectMainSection(tabs[next].dataset.mainSectionTab, { focus: true });
        });
        return tab;
      });
      list.replaceChildren(...tabs);
      const key = panels.some(panel => panel.dataset.mainSection === state[stateKey]) ? state[stateKey] : panels[0]?.dataset.mainSection;
      if (key) selectMainSection(key, { focus: focused === key });
    }
  }

  function renderInputs() {
    const before = $("input-sections");
    const postMaterials = $("post-material-input-sections");
    const after = $("adjustment-sections");
    const materials = $("material-inputs");
    const project = $("project-input-fields");
    const notes = $("estimate-notes-section");
    before.replaceChildren(); postMaterials.replaceChildren(); after.replaceChildren(); materials.replaceChildren(); project.replaceChildren();
    const job = [], labour = [], masking = [], adjustments = [], additions = [], remainder = [];
    for (const field of state.fields) {
      // Keep historical workbook notes in the snapshot without a second editor.
      if (field.cell === "B12") continue;
      if (/^[BCDE](1[5-9]|2[0-3])$/.test(field.cell)) continue;
      if (field.cell === "B8") project.append(makeControl(field));
      else if (field.cell === "B9" || field.cell === "B10") masking.push(field);
      else if (/^B[2-7]$/.test(field.cell)) job.push(field);
      else if (/^D[2-9]$/.test(field.cell) || field.cell === "D10") labour.push(field);
      else if (/^B2[6-8]$/.test(field.cell)) adjustments.push(field);
      else if (/^[EF]2[6-8]$/.test(field.cell)) additions.push({ ...field, label: additionLabels[field.cell] });
      else remainder.push(field);
    }
    const maskingActive = String(state.inputs.D7 ?? "").trim().toLowerCase() !== "n/a";
    for (const card of [inputCard("access-travel", "Access & Travel", job), inputCard("teams-crews", "Teams/Crews", labour)]) if (card) before.append(card);
    const maskingCard = maskingActive ? inputCard("masking-cleaning", "Masking/Cleaning", masking) : null;
    if (maskingCard) postMaterials.append(maskingCard);
    for (let row = 15; row <= 23; row++) {
      materials.append(renderMaterialRow(row));
      for (const item of state.workItems.filter(item => item.source_row === row)) materials.append(renderMaterialRow(row, item));
    }
    updateMaterialRowVisibility();
    const additionCard = inputCard("additions", "Additions", additions);
    additionCard?.querySelector(".fields").classList.add("two-columns");
    const adjustmentCard = inputCard("global-adjustments", "Global Adjustments", adjustments, "Percentage inputs are shown as percentages: enter 10 for 10%. A negative global amount deducts from the quote.");
    if (adjustmentCard && additionCard) {
      delete adjustmentCard.dataset.mainSection;
      adjustmentCard.classList.remove("main-section-panel", "card");
      additionCard.append(adjustmentCard);
    }
    if (additionCard) additionCard.append(notes);
    for (const card of [
      additionCard,
      inputCard("other-inputs", "Other estimate inputs", remainder),
    ]) if (card) after.append(card);
    renderMainSectionTabs();
    validateCoverageTeams();
    if ([...state.inputErrors.values()].includes("Select Teams")) showInputProblems();
  }

  function clearResults(status) {
    window.CeasefireI18n.text($("calculation-status"), status);
    document.querySelector(".summary-card").setAttribute("aria-busy", "true");
    for (const key of ["labour", "material", "access", "travel", "material-adjustment", "labour-adjustment", "subtotal", "adjustment", "total", "rate", "days"]) $( `sum-${key}`).textContent = "—";
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = "—";
    for (const item of state.workItems) { const output = $(`yield-work-item-${item.id}`); if (output) output.textContent = "—"; }
    const row = node("tr"); const cell = uiNode("td", "", status === "Calculating…" ? "Calculating…" : "No current calculation is available.");
    cell.colSpan = 5; row.append(cell); $("material-results").replaceChildren(row);
    const labourRow = node("tr"), labourCell = uiNode("td", "", status === "Calculating…" ? "Calculating…" : "No current calculation is available.");
    labourCell.colSpan = 2; labourRow.append(labourCell); $("labour-results").replaceChildren(labourRow);
    $("labour-breakdown").setAttribute("aria-busy", "true");
    $("calculation-errors").hidden = true;
    for (const control of document.querySelectorAll("[data-cell]")) control.removeAttribute("aria-invalid");
  }

  function scheduleCalculation() {
    state.revision++;
    state.result = null;
    clearTimeout(state.timer);
    if (inputProblem()) { showInputProblems(); return; }
    clearResults("Calculating…");
    state.timer = setTimeout(() => { calculate(); }, 180);
  }

  async function calculate() {
    clearTimeout(state.timer);
    const revision = ++state.revision;
    if (inputProblem()) { showInputProblems(); return null; }
    clearResults("Calculating…");
    try {
      const body = JSON.stringify({ inputs: state.inputs, work_items: state.workItems, configuration: state.quoteConfiguration || state.configuration, workflow: state.workflow, ...(window.CeasefirePenetrations?.quoteSnapshot?.() ? { penetration: window.CeasefirePenetrations.quoteSnapshot() } : {}) });
      const result = await calculationQueue.run(() => request("/api/calculate", { method: "POST", body }),
        () => revision === state.revision && !inputProblem());
      if (!result || revision !== state.revision) return null;
      state.result = result;
      renderResults(result);
      return result;
    } catch (error) {
      if (error.name === "AbortError" || revision !== state.revision) return null;
      clearResults("Calculation unavailable");
      $("labour-breakdown").setAttribute("aria-busy", "false");
      document.querySelector(".summary-card").setAttribute("aria-busy", "false");
      const box = $("calculation-errors");
      box.textContent = error.message;
      box.hidden = false;
      return null;
    }
  }

  function renderResults(result) {
    const summary = result.summary || {};
    const cells = result.cells || {};
    const errors = result.errors || {};
    for (const key of ["labour", "material", "access", "travel", "subtotal", "total", "rate"]) $(`sum-${key}`).textContent = formatMoney(summary[key]);
    $("sum-days").textContent = formatNumber(summary.days);
    $("sum-material-adjustment").textContent = formatMoney(result.global_adjustments?.material?.amount);
    $("sum-labour-adjustment").textContent = formatMoney(result.global_adjustments?.labour?.amount);
    $("sum-adjustment").textContent = formatMoney(cells.D27 ?? state.inputs.B28 ?? 0);
    for (let row = 15; row <= 23; row++) $(`yield-${row}`).textContent = formatNumber(cells[`F${row}`]);
    for (const item of result.work_items || []) { const output = $(`yield-work-item-${item.id}`); if (output) output.textContent = formatNumber(item.yield); }
    const materialRows = [];
    for (const material of result.materials || []) {
      if (displaysZero(material.total, money)) continue;
      const row = node("tr");
      row.append(materialNameCell(material), node("td", "numeric", formatNumber(material.quantity)),
        node("td", "numeric", formatMoney(material.price)), node("td", "numeric", formatMoney(material.total)),
        node("td", "numeric", formatNumber(material.days)));
      materialRows.push(row);
    }
    if (!materialRows.length) { const row = node("tr"); const cell = uiNode("td", "", result.materials?.length ? "No material costs." : "No material requirements."); cell.colSpan = 5; row.append(cell); materialRows.push(row); }
    $("material-results").replaceChildren(...materialRows);
    const labour = result.labour, labourRows = [];
    if (labour) {
      const addDays = (label, days, className = "") => {
        if (displaysZero(days, quantity)) return;
        const row = node("tr", className), labelCell = uiNode("th", "", label);
        labelCell.scope = "row"; row.append(labelCell, node("td", "numeric", formatNumber(days))); labourRows.push(row);
      };
      for (const task of labour.tasks || []) if (task.source !== "firestopping") addDays(task.name, task.days);
      if ((labour.tasks || []).some(task => task.source === "firestopping")) addDays("Firestopping", labour.firestopping_days);
      addDays("Masking / cleaning", labour.masking_days);
      addDays("Extra labour", labour.extra_days);
      addDays("Mobilisation allowance", labour.mobilisation_days);
      addDays("Total project days", labour.total_days, "labour-total");
    }
    if (!labourRows.length) {
      const row = node("tr"), cell = uiNode("td", "", labour ? "No labour days." : "Labour breakdown is unavailable for this result.");
      cell.colSpan = 2; row.append(cell); labourRows.push(row);
    }
    $("labour-results").replaceChildren(...labourRows);
    $("labour-breakdown").setAttribute("aria-busy", "false");
    const entries = Object.entries(errors);
    window.CeasefireI18n.text($("calculation-status"), entries.length ? "Check errors" : "Calculated");
    document.querySelector(".summary-card").setAttribute("aria-busy", "false");
    const box = $("calculation-errors");
    box.replaceChildren();
    box.hidden = !entries.length;
    if (entries.length) {
      box.append(uiNode("strong", "", "Some estimate calculations need attention."));
      const list = node("ul");
      const details = result.error_details || [{ message: "Recalculate this estimate to see which inputs need attention." }];
      for (const error of details) list.append(node("li", "", error.message || `${error.label} could not be calculated. Check its inputs.`));
      for (const [cell] of entries) $(`input-${cell}`)?.setAttribute("aria-invalid", "true");
      box.append(list);
    }
  }

  function materialNameCell(material) {
    // Selected products are source data. Only the application's fallback name
    // for an unselected Firestopping product has translatable task/context parts.
    const name = material.name || "—";
    if (material.source === "firestopping" && material.product === null) {
      const adjustment = String(name).match(/^Line (\d+) · Material adjustment$/);
      if (adjustment && material.context === "Material adjustment") return uiNode("td", "", "{0} · {1}", [window.CeasefireI18n.term("Line {0}", [adjustment[1]]), window.CeasefireI18n.term("Material adjustment")]);
      const tasks = new Set(["Board", "Collars", "Mastic", "Framing", "Wrap", "Other"]);
      const contexts = new Set(["Substrate", "Bulkhead", "Collars", "Mastic Qty", "Pipes", "Cabletrays", "Additional material"]);
      const item = String(name).match(/^Item (\d+) (.+) · (.+)$/);
      if (item && tasks.has(item[2]) && contexts.has(item[3]) && material.context === item[3]) return uiNode("td", "", "Item {0} {1} · {2}", [item[1], window.CeasefireI18n.term(item[2]), window.CeasefireI18n.term(item[3])]);
    }
    return node("td", "", name);
  }

  let confirmationQueue = Promise.resolve();

  function confirmReplace(title, detail, action, cancel = uiCopy("Keep editing")) {
    return chooseReplacement(title, detail, action, cancel).then(choice => choice === "confirm");
  }

  function chooseReplacement(title, detail, action, cancel, alternate = null) {
    // An import can finish while another confirmation is open. Each operation
    // needs its own answer; one click must never confirm two replacements.
    const answer = confirmationQueue.then(() => new Promise((resolve) => {
      const dialog = $("discard-dialog");
      uiText(dialog.querySelector("h2"), title);
      uiText(dialog.querySelector("p"), detail);
      uiText(dialog.querySelector('[value="cancel"]'), cancel);
      uiText(dialog.querySelector('[value="confirm"]'), action);
      const extra = alternate && uiNode("button", "button secondary", alternate);
      if (extra) { extra.value = "alternate"; dialog.querySelector(".actions").append(extra); }
      dialog.addEventListener("close", () => { extra?.remove(); resolve(dialog.returnValue); }, { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    }));
    confirmationQueue = answer.catch(() => {});
    return answer;
  }

  async function notify(title, detail) { message(detail || title, true); }

  async function newQuote() {
    if (state.projectBusy || coverReplacementPending()) return;
    if (window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    if (projectHasChanges() && !await confirmReplace(uiCopy("Start a new project?"), uiCopy("The Quote, Firestopping items, {0}project library drafts, project pricing and all three specialist calculator drafts will be replaced with defaults using your saved pricing library. Shared libraries stay unchanged.", [window.CeasefireI18n.term(takeoffContents())]), uiCopy("New project"))) return;
    projectBusy(true, "new-quote");
    try {
    let preparedCertification = null, preparedDocumentation = null;
    if (state.initialized) {
      try {
        const captured = projectReplacementStamp();
        preparedCertification = await window.CeasefireCertification?.prepareProject?.();
        preparedDocumentation = await window.CeasefireDocumentation?.prepareProject?.(undefined, preparedCertification?.workspace_id);
        const [prepared, penetration, takeoffs, libraryDrafts] = await Promise.all([window.CeasefireCalculators.prepareDefaults(), window.CeasefirePenetrations?.prepareDefaults(state.configuration), window.CeasefireTakeoffs?.prepareDefaults(), window.CeasefireLibraryEditor?.prepareProject?.()]);
        if (coverReplacementPending()) { await window.CeasefireCertification?.discardPreparedSession?.(preparedCertification?.workspace_id); return; }
        if (captured !== projectReplacementStamp()) throw new Error("The current project changed while preparing defaults. Try again when ready.");
        window.CeasefireCalculators.applyProject(prepared);
        if (penetration) window.CeasefirePenetrations.applyProject(penetration);
        if (takeoffs) window.CeasefireTakeoffs.applyProject(takeoffs);
        if (libraryDrafts) window.CeasefireLibraryEditor.applyProject(libraryDrafts);
      } catch (error) { await window.CeasefireCertification?.discardPreparedSession?.(preparedCertification?.workspace_id); message(error.message, true); return; }
    }
    state.quoteContext++;
    state.quoteLoadRevision++;
    state.inputErrors.clear(); state.inputDrafts.clear(); state.workItemErrors.clear(); state.workItemDrafts.clear();
    state.quote = null; state.quoteConfiguration = null; state.projectFile = null; state.projectStatus = "New"; savedProjectFollowUp = projectFollowUp = followUpFields(); resetEstimateCollection();
    resetProjectPricing();
    state.fields = clone(state.currentFields);
    // Start notes blank without changing workbook defaults or saved-quote inputs.
    state.inputs = Object.fromEntries(state.fields.map((field) => [field.cell, field.cell === "B12" ? "" : field.default ?? ""]));
    state.workItems = []; state.nextWorkItem = 1;
    state.legacyTitle = "";
    applyQuoteDetails();
    updateQuoteTitle();
    if (preparedCertification) window.CeasefireCertification.applyProject(preparedCertification);
    window.CeasefireDocumentation?.applyProject?.(preparedDocumentation);
    window.ClassifirePassiveRegister?.applyProject();
    window.CeasefireCommercial?.applyProject?.({workspace_id:preparedCertification?.workspace_id || null});
    window.CeasefireSWMS?.applyProject?.({workspace_id:preparedCertification?.workspace_id || null});
    state.workflow = state.defaultWorkflow;
    $("measurements").value = "";
    $("snapshot-message").hidden = true;
    selectEstimator("estimate"); renderInputs(); updateDirty(false); message(uiCopy("")); showView("estimate"); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
    if (state.initialized && window.CeasefireProjectPane) { await showView("quotes"); await window.CeasefireProjectPane.openCurrent(); }
    } finally { projectBusy(false); }
  }

  async function saveQuote() {
    if (inputProblem()) { message(inputProblem(), true); return; }
    updateQuoteTitle();
    const title = $("quote-title").value.trim();
    const button = $("save-quote"); button.disabled = true;
    try {
      const inputs = clone(state.inputs);
      const workflow = state.workflow;
      const measurements = $("measurements").value;
      const configuration = clone(state.quoteConfiguration || state.configuration);
      const quoteContext = state.quoteContext;
      const inputRevision = state.inputRevision;
      const details = quoteDetails();
      const workItems = clone(state.workItems);
      const penetration = window.CeasefirePenetrations?.quoteSnapshot?.();
      const penetrationStamp = window.CeasefirePenetrations?.quoteFingerprint?.();
      const payload = { title, inputs, work_items: workItems, workflow, measurements, configuration, ...details, ...(penetration ? { penetration } : {}) };
      const saved = await request(state.quote ? `/api/quotes/${encodeURIComponent(state.quote.id)}` : "/api/quotes", { method: state.quote ? "PUT" : "POST", body: JSON.stringify(payload) });
      if (quoteContext !== state.quoteContext) { message(uiCopy("Saved “{0}”. Your currently open estimate has been kept.", [title])); return; }
      const pricingChangedDuringSave = JSON.stringify(state.quoteConfiguration || state.configuration) !== JSON.stringify(configuration);
      state.quote = saved;
      if ([saved.project_no, saved.client, saved.site_address].some((value) => typeof value === "string" && value.trim())) state.legacyTitle = "";
      updateQuoteTitle();
      if (!pricingChangedDuringSave) state.quoteConfiguration = clone(saved.configuration || configuration);
      if (!pricingChangedDuringSave && saved.fields) { state.fields = clone(saved.fields); renderInputs(); }
      $("snapshot-message").hidden = false;
      if (!pricingChangedDuringSave) window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "This quote uses its saved pricing snapshot.");
      const changedDuringSave = pricingChangedDuringSave || state.inputRevision !== inputRevision || state.inputErrors.size > 0 || state.workItemErrors.size > 0 || JSON.stringify(state.inputs) !== JSON.stringify(inputs) || JSON.stringify(state.workItems) !== JSON.stringify(workItems) || window.CeasefirePenetrations?.quoteFingerprint?.() !== penetrationStamp || JSON.stringify(window.CeasefirePenetrations?.quoteSnapshot?.()) !== JSON.stringify(penetration) || JSON.stringify(quoteDetails()) !== JSON.stringify(details) || $("quote-title").value.trim() !== title || state.workflow !== workflow || $("measurements").value !== measurements;
      updateDirty(changedDuringSave);
      message(changedDuringSave ? uiCopy("Saved “{0}”. Changes made while saving still need to be saved.", [title]) : uiCopy("Saved “{0}” with its inputs and pricing snapshot.", [title]));
    } catch (error) { message(uiCopy("Quote was not saved. {0}", [error.message]), true); }
    finally { button.disabled = false; }
  }

  async function loadQuotes() {
    const list = $("quote-list"); window.CeasefireI18n.text(list, "Loading saved quotes…");
    try {
      const data = await request("/api/quotes");
      if (!(data.quotes || []).length) { list.replaceChildren(uiNode("p", "empty-state", "No older estimate-only saves.")); return; }
      list.replaceChildren(...data.quotes.map((quote) => {
        const item = node("article", "quote-item");
        const description = node("div");
        description.append(node("h3", "", quote.title || "Untitled quote"));
        const date = new Date(quote.updated_at);
        description.append(Number.isNaN(date.getTime()) ? uiNode("p", "", "Saved locally") : uiNode("p", "", "Updated {0}", [date.toLocaleString("en-AU")]));
        const button = uiNode("button", "button secondary", "Open older estimate");
        button.type = "button";
        button.addEventListener("click", () => openQuote(quote.id, button));
        item.append(description, button); return item;
      }));
    } catch (error) { list.replaceChildren(node("p", "message error", error.message)); }
  }

  async function openQuote(id, button) {
    if (state.projectBusy || coverReplacementPending()) return;
    if (window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    button.disabled = true;
    const loadRevision = ++state.quoteLoadRevision;
    let preparedCertification = null, preparedDocumentation = null, certificationAdopted = false;
    try {
      const quote = await request(`/api/quotes/${encodeURIComponent(id)}`);
      if (loadRevision !== state.quoteLoadRevision) return;
      const captured = projectReplacementStamp();
      preparedCertification = await window.CeasefireCertification?.prepareProject?.();
      preparedDocumentation = await window.CeasefireDocumentation?.prepareProject?.(undefined, preparedCertification?.workspace_id);
      const [prepared, penetration, takeoffs] = await Promise.all([window.CeasefireCalculators.prepareDefaults(), quote.penetration
        ? window.CeasefirePenetrations?.prepareProject(quote.penetration, quote.configuration || state.configuration)
        : window.CeasefirePenetrations?.prepareDefaults(quote.configuration || state.configuration), window.CeasefireTakeoffs?.prepareDefaults()]);
      const scope = quote.penetration ? "This record contains the estimate, its firestopping schedule and original pricing. The current item and other calculators will start from defaults." : "This record contains the estimate and its original pricing only. The penetration schedule and all calculators will start from defaults.";
      if (!await confirmReplace(uiCopy("Open this older estimate?"), uiCopy("{0} The current estimate will be replaced. Save can then save them together.", [window.CeasefireI18n.term(scope)]), uiCopy("Open older estimate"))) return;
      if (coverReplacementPending()) return;
      if (captured !== projectReplacementStamp()) throw new Error("The current project changed during review. Open the older estimate again when ready.");
      if (loadRevision !== state.quoteLoadRevision) return;
      state.quoteContext++;
      state.inputErrors.clear(); state.inputDrafts.clear(); state.workItemErrors.clear(); state.workItemDrafts.clear();
      state.quote = quote;
      state.projectFile = null; state.projectStatus = "New"; savedProjectFollowUp = projectFollowUp = followUpFields(); resetEstimateCollection();
      window.CeasefireCalculators.applyProject(prepared);
      if (penetration) window.CeasefirePenetrations.applyProject(penetration);
      if (takeoffs) window.CeasefireTakeoffs.applyProject(takeoffs);
      state.quoteConfiguration = clone(quote.configuration || state.configuration);
      resetProjectPricing("project");
      state.fields = clone(quote.fields || state.currentFields);
      state.inputs = { ...Object.fromEntries(state.fields.map((field) => [field.cell, field.default ?? ""])), ...quote.inputs };
      state.workItems = clone(quote.work_items || []); state.nextWorkItem = state.workItems.length + 1;
      state.legacyTitle = [quote.project_no, quote.client, quote.site_address].some((value) => typeof value === "string" && value.trim()) ? "" : quote.title || "";
      applyQuoteDetails(quote);
      updateQuoteTitle();
      if (preparedCertification) { window.CeasefireCertification.applyProject(preparedCertification); certificationAdopted = true; }
      window.CeasefireDocumentation?.applyProject?.(preparedDocumentation);
      window.ClassifirePassiveRegister?.applyProject();
      state.workflow = typeof quote.workflow === "string" ? quote.workflow : state.defaultWorkflow;
      $("measurements").value = typeof quote.measurements === "string" ? quote.measurements : JSON.stringify(quote.measurements || "");
      $("snapshot-message").hidden = false;
      window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "This quote uses its saved pricing snapshot.");
      selectEstimator("estimate"); renderInputs(); updateDirty(false); message(uiCopy("")); showView("estimate"); scheduleCalculation();
      window.CeasefirePenetrations?.pricingChanged();
    } catch (error) { message(uiCopy("Could not open the quote. {0}", [error.message]), true); }
    finally { if (preparedCertification && !certificationAdopted) await window.CeasefireCertification?.discardPreparedSession?.(preparedCertification.workspace_id); button.disabled = false; }
  }

  function selectEstimator(kind) {
    if (!["estimate", "penetration"].includes(kind)) return;
    state.estimatorKind = kind;
    state.estimateKind = "estimate";
    $("estimator-main").hidden = kind !== "estimate";
    $("estimator-penetration").hidden = kind !== "penetration";
    for (const button of document.querySelectorAll("[data-estimator-kind]")) button.setAttribute("aria-pressed", String(button.dataset.estimatorKind === kind));
    if (kind === "penetration") $("calculator-workspace").hidden = true;
    const libraryEditor = !!window.CeasefireLibraryEditor?.isOpen();
    $("firestopping-project-workspace").hidden = libraryEditor;
    const penetrationHeading = $("penetration-heading")?.closest(".penetration-banner-heading");
    if (penetrationHeading) penetrationHeading.hidden = libraryEditor || state.currentView !== "calculators" || kind !== "penetration";
    $("firestopping-library-editor").hidden = !libraryEditor;
    $("estimator-penetration").setAttribute("aria-labelledby", libraryEditor ? "library-editor-heading" : "penetration-heading");
    window.CeasefireCalculators?.refreshNavigation?.();
    if (kind === "penetration" && !libraryEditor) return window.CeasefirePenetrations?.open();
    if (kind === "estimate") return window.CeasefirePenetrations?.openSchedule?.();
  }

  function selectLibrary(kind, selection) {
    if (!["pricing", "penetration", "technical"].includes(kind)) return;
    document.activeElement?.blur?.();
    state.libraryKind = kind;
    refreshWorkspaceHeading("pricing", kind);
    for (const child of ["pricing", "penetration", "technical"]) $("library-" + child).hidden = child !== kind;
    for (const button of document.querySelectorAll("[data-library-kind]")) button.setAttribute("aria-pressed", String(button.dataset.libraryKind === kind));
    window.CeasefireNotifications?.navigate(`pricing:${kind}`);
    if (kind === "pricing") { window.CeasefireLibraries?.leave?.(); if (!pricingViewCurrent()) renderPricing(); }
    else window.CeasefireLibraries?.open(kind, selection);
  }

  function resolveView(view) {
    return view === "projects" ? state.lastProjectSection || "quotes" : view === "documents" ? "documentation" : view;
  }

  async function showView(view, librarySelection, calculatorId, commercialDraftOwner) {
    view = resolveView(view);
    const previousView = state.currentView;
    if (view !== previousView && previousView === "contacts" && window.ClassifireContacts?.leave && !await window.ClassifireContacts.leave()) return;
    if (view !== state.currentView && state.currentView === "quotes" && window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    if (view !== state.currentView && window.CeasefireCommercial?.hasPendingOperation?.() && !await window.CeasefireCommercial.leaveEditor()) return;
    if (view !== state.currentView && window.CeasefireScheduler?.hasPendingOperation?.() && !await window.CeasefireScheduler.leave()) return;
    if (view !== state.currentView && window.CeasefireCoverSheets?.hasPendingOperation?.()) { message(uiCopy("Finish or retry the current cover-sheet operation before changing views."), true); return; }
    if (view !== state.currentView && window.CeasefireCoverSheets?.hasUnsavedChanges?.() && !await window.CeasefireCoverSheets.leave()) return;
    if (view !== state.currentView && (window.CeasefireCertification?.hasPendingNavigationOperation?.() ?? window.CeasefireCertification?.hasPendingOperation?.())) { message(uiCopy("Finish or retry the current certification operation before changing views."), true); return; }
    if (window.CeasefirePenetrations?.hasTakeoffReservation?.() || window.CeasefireTakeoffs?.hasLinkedRecovery?.()) { message(uiCopy("Finish or recover the confirmed Takeoff library link before changing views."), true); return; }
    if (view === "takeoffs" && !state.takeoffsEnabled) { message(uiCopy("TAKEOFFS is not included in this edition."), true); return; }
    if (view !== state.currentView && window.CeasefireSWMS?.hasPendingOperation?.() && !await window.CeasefireSWMS.leaveEditor()) return;
    window.CeasefireNotifications?.navigate(view === "pricing" ? `pricing:${state.libraryKind}` : view === "calculators" ? `calculators:${calculatorId || state.calculatorKind}` : view === "estimate" ? `estimate:${state.estimateKind || "estimate"}` : view);
    if (view !== state.currentView && $("app-message").hidden) releaseMessageSpace();
    if (previousView === "pricing" && view !== previousView) window.CeasefireLibraries?.leave?.();
    state.currentView = view;
    refreshProjectPages();
    refreshDocumentPages();
    if (["quotes", "quote", "work-orders", "purchase-orders"].includes(view)) state.lastProjectSection = view;
    if (["certification", "documentation", "swms"].includes(view)) state.lastDocumentSection = view;
    $("project-tools").hidden = true;
    closeNavigationMenus({ estimate: "estimate-navigation", calculators: "calculator-navigation", pricing: "library-navigation", takeoffs: "takeoff-navigation", contacts: "contacts-navigation" }[view]);
    document.body.classList.toggle("takeoffs-active", view === "takeoffs");
    clearTimeout(state.projectsTimer); ++state.projectsRevision;
    $("project-list").setAttribute("aria-busy", "false");
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${view}`;
    window.CeasefirePlay?.setVisible(view === "play");
    for (const button of document.querySelectorAll("[data-view]")) {
      const active = button.dataset.view === view || (view === "play" && button.dataset.view === "settings") || (["quotes", "quote", "work-orders", "purchase-orders"].includes(view) && button.dataset.view === "projects") || (["certification", "documentation", "swms", "passive-fire-register"].includes(view) && button.dataset.view === "documents");
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    for (const choice of document.querySelectorAll("#projects-navigation-menu [data-project-section]")) choice.setAttribute("aria-pressed", String(choice.dataset.projectSection === view));
    for (const choice of document.querySelectorAll("#documents-navigation-menu [data-document-section]")) choice.setAttribute("aria-pressed", String(choice.dataset.documentSection === view));
    if (view === "quotes") loadProjects();
    if (view === "scheduler") window.CeasefireScheduler?.activate().catch(error => message(error.message, true));
    let estimatorReady;
    if (view === "contacts" && previousView !== "contacts") estimatorReady = window.ClassifireContacts?.activate().catch(error => message(error.message, true));
    if (view === "passive-fire-register") window.ClassifirePassiveRegister.open();
    if (view === "swms") estimatorReady = window.CeasefireSWMS?.activate().catch(error => message(error.message, true));
    if (["quote", "work-orders", "purchase-orders"].includes(view)) estimatorReady = window.CeasefireCommercial?.activate({quote:"quote", "work-orders":"work_order", "purchase-orders":"purchase_order"}[view], commercialDraftOwner).catch(error => message(error.message, true));
    if (view === "pricing") selectLibrary(state.libraryKind, librarySelection);
    if (view === "certification") estimatorReady = window.CeasefireCertification?.open().catch(error => message(error.message, true));
    if (view === "documentation") estimatorReady = Promise.all([window.CeasefireDocumentation?.open(), window.CeasefireCoverSheets?.open?.()]).catch(error => message(error.message, true));
    if (view === "calculators") {
      calculatorId ||= state.calculatorKind;
      if (calculatorId === "steel") calculatorId = "steel_vermiculite";
      state.calculatorKind = calculatorId;
      refreshWorkspaceHeading("calculators", calculatorId);
      if (calculatorId === "penetration") estimatorReady = selectEstimator("penetration");
      else { $("estimator-penetration").hidden = true; state.estimatorKind = "estimate"; estimatorReady = calculatorId ? window.CeasefireCalculators?.select(calculatorId) : window.CeasefireCalculators?.open(); }
    }
    if (view === "estimate") estimatorReady = selectEstimator(state.estimateKind || "estimate");
    if (view === "takeoffs") estimatorReady = window.CeasefireTakeoffs?.open().catch(error => message(error.message, true));
    // Each section starts with its heading and actions visible below the sticky
    // header, even when the previous estimate was scrolled far down the page.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return estimatorReady;
  }

  function getOverride(kind, id) { return state.draft[kind]?.[id] || {}; }

  function markPricingDirty() {
    state.pricingDirty = draftChanged(state.draft, pricingBaseline());
    if (state.pricingScope === "project") state.projectPricingDraft = state.draft;
    else state.libraryDraft = state.draft;
    window.CeasefireI18n.text($("pricing-status"), state.pricingDirty ? "Unsaved pricing changes" : state.pricingScope === "project" ? "Project pricing" : "Saved library");
    updateProjectStatus();
  }

  function pricingBaseline() { return state.pricingScope === "project" ? state.quoteConfiguration || state.configuration : state.configuration; }
  function draftChanged(draft, baseline) { return !!draft && (pricingHasPendingInput(draft) || JSON.stringify(draft) !== JSON.stringify(baseline)); }
  function sharedPricingDraft() { return state.pricingScope === "library" ? state.draft : state.libraryDraft; }
  function sharedPricingChanged() { return draftChanged(sharedPricingDraft(), state.configuration); }
  function pricingLibraryPageDirty() {
    return state.currentView === "pricing" && state.libraryKind === "pricing" && state.pricingScope === "library" && sharedPricingChanged();
  }
  async function confirmLeavePricingLibrary() {
    document.activeElement?.blur?.();
    if (!pricingLibraryPageDirty()) return true;
    const draft = state.draft, fingerprint = JSON.stringify(draft), pending = JSON.stringify([...pricingPendingFields(draft)]);
    if (!await confirmReplace(uiCopy("Unsaved Pricing Library"), uiCopy(pricingUnsavedPrompt), uiCopy("Continue"), uiCopy("Cancel"))) return false;
    if (state.draft !== draft || JSON.stringify(state.draft) !== fingerprint || JSON.stringify([...pricingPendingFields(draft)]) !== pending) {
      message(uiCopy("The Pricing Library changed while the confirmation was open. Review the current changes and try again."), true);
      return false;
    }
    return true;
  }
  async function requestViewNavigation(view, librarySelection, commercialDraftOwner) {
    view = resolveView(view);
    if (view === state.currentView && view === state.lastProjectSection) {
      closeNavigationMenus();
      window.CeasefireHeaderTagline?.next();
      return true;
    }
    if (["documentation", "passive-fire-register"].includes(view) && !requireCreatedProject()) return false;
    if (view !== state.currentView && !await confirmLeavePricingLibrary()) return false;
    await showView(view, librarySelection, undefined, commercialDraftOwner);
    if (state.currentView === view) window.CeasefireHeaderTagline?.next();
    return state.currentView === view;
  }
  function requestDocumentsNavigation() {
    return requestViewNavigation(state.lastDocumentSection || "documentation");
  }
  async function requestCalculatorNavigation(id = state.calculatorKind) {
    if (!["steel", "steel_vermiculite", "steel_intumescent", "steel_board", "steel_factors", "ductwork", "penetration"].includes(id)) return false;
    document.activeElement?.blur?.();
    if (state.currentView !== "calculators" && !await confirmLeavePricingLibrary()) return false;
    if (window.CeasefireCalculators?.hasPendingOperation?.()) {
      message(uiCopy("Finish the current calculator action before choosing another calculator."), true); return false;
    }
    if (window.CeasefireCalculators?.canSelect?.(id) === false) return false;
    state.estimatorKind = "estimate";
    await showView("calculators", undefined, id);
    if (state.currentView === "calculators") window.CeasefireHeaderTagline?.next();
    return state.currentView === "calculators";
  }
  async function requestEstimateNavigation(kind) {
    if (kind === "penetration") return requestCalculatorNavigation(kind);
    if (!["estimate", "penetration"].includes(kind)) return false;
    document.activeElement?.blur?.();
    if (state.currentView !== "estimate" && !await confirmLeavePricingLibrary()) return false;
    if (window.CeasefireCalculators?.hasPendingOperation?.()) { message(uiCopy("Finish the current calculator action before choosing an estimate."), true); return false; }
    state.estimateKind = kind;
    await showView("estimate");
    if (state.currentView === "estimate") window.CeasefireHeaderTagline?.next();
    return state.currentView === "estimate";
  }
  function positionNavigationMenu(menu) {
    // Relative positioning keeps wrapped menus beside their actual owner.
    // Clamp only the horizontal edge, accounting for the header's native zoom.
    menu.style.left = "0px";
    const bounds = menu.getBoundingClientRect(), scale = bounds.width / menu.offsetWidth;
    if (!Number.isFinite(scale) || scale <= 0) return;
    // A temporarily overflowing menu can widen innerWidth on mobile browsers.
    const viewportWidth = document.documentElement.clientWidth > 0 ? document.documentElement.clientWidth : window.innerWidth;
    const left = Math.max(14, Math.min(bounds.left, viewportWidth - 14 - bounds.width));
    menu.style.left = `${(left - bounds.left) / scale}px`;
  }
  function setCalculatorMenuOpen(open) {
    const menu = $("calculator-navigation-menu"), toggle = $("calculator-navigation-toggle");
    if (!menu || !toggle) return;
    if (open) closeNavigationMenus("calculator-navigation");
    menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
    if (open) window.CeasefireCalculators?.refreshNavigation?.();
    if (open) positionNavigationMenu(menu);
    if (!open) {
      const submenu = $("steel-calculator-navigation-menu"), parent = $("steel-calculator-navigation-toggle");
      if (submenu && parent) { submenu.hidden = true; parent.setAttribute("aria-expanded", "false"); }
    }
  }
  function setupSectionNavigation(id, selector, setOpen, navigate) {
    const navigation = $(id), toggle = $(id + "-toggle"), menu = $(id + "-menu");
    if (!navigation || !toggle || !menu) return;
    const choices = [...menu.querySelectorAll(selector)];
    const visibleChoices = () => choices.filter(choice => !choice.closest?.('.section-navigation-subgroup[hidden]'));
    navigation.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") setOpen(true); });
    navigation.addEventListener("pointerleave", event => { if (event.pointerType !== "touch" && !navigation.contains(document.activeElement)) setOpen(false); });
    navigation.addEventListener("focusin", () => setOpen(true));
    navigation.addEventListener("focusout", event => { if (!navigation.contains(event.relatedTarget)) setOpen(false); });
    toggle.addEventListener("click", () => setOpen(true));
    navigation.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); toggle.focus(); setOpen(false); return; }
      const available = visibleChoices(), index = available.indexOf(event.target);
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); setOpen(true);
        const next = index < 0 ? event.key === "ArrowDown" ? 0 : available.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
        available[next]?.focus();
      } else if (index >= 0 && ["Home", "End"].includes(event.key)) {
        event.preventDefault(); available[event.key === "Home" ? 0 : available.length - 1]?.focus();
      }
    });
    for (const choice of choices) choice.addEventListener("click", event => {
      if (choice.id === "steel-calculator-navigation-toggle") {
        $("steel-calculator-navigation-menu").hidden = false; choice.setAttribute("aria-expanded", "true"); return;
      }
      if (choice.id === "penetration-navigation-toggle" && event.pointerType === "touch") {
        $("penetration-navigation-menu").hidden = false; choice.setAttribute("aria-expanded", "true"); return;
      }
      setOpen(false);
      navigate(choice).catch(error => message(error.message, true));
    });
    window.addEventListener("pointerdown", event => { if (!navigation.contains(event.target)) setOpen(false); });
  }
  function setupWorkspaceTabs(id, selector, navigate) {
    const strip = $(id);
    for (const button of strip?.querySelectorAll(selector) || []) button.addEventListener("click", () => {
      Promise.resolve(navigate(button)).catch(error => message(error.message, true));
    });
    strip?.addEventListener("keydown", event => {
      const tabs = [...strip.querySelectorAll(selector)].filter(button => !button.disabled), index = tabs.indexOf(event.target);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const forward = document.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
      tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === forward ? 1 : -1) + tabs.length) % tabs.length]?.focus();
    });
  }
  function setSectionMenuOpen(id, open) {
    const menu = $(id + "-menu"), toggle = $(id + "-toggle");
    if (!menu || !toggle) return;
    if (open) closeNavigationMenus(id);
    menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
    if (open && id === "takeoff-navigation") window.CeasefireTakeoffs?.refreshNavigation?.();
    if (open) positionNavigationMenu(menu);
  }
  function closeNavigationMenus(except) {
    for (const id of sectionNavigationIds) {
      if (id === except) continue;
      if (id === "calculator-navigation") { setCalculatorMenuOpen(false); continue; }
      const menu = $(id + "-menu"), toggle = $(id + "-toggle");
      if (menu && toggle) { menu.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    }
  }
  const sectionNavigationIds = ["estimate-navigation", "calculator-navigation", "library-navigation", "takeoff-navigation", "projects-navigation", "documents-navigation", "contacts-navigation", "settings-navigation"];
  function setupCalculatorNavigation() {
    window.addEventListener("resize", () => {
      for (const id of sectionNavigationIds) {
        const menu = $(id + "-menu");
        if (menu && !menu.hidden) positionNavigationMenu(menu);
      }
    });
    for (const id of ["penetration-navigation", "steel-calculator-navigation"]) {
      const branch = $(id), parent = $(id + "-toggle"), submenu = $(id + "-menu");
      if (branch && parent && submenu) {
        const open = value => { submenu.hidden = !value; parent.setAttribute("aria-expanded", String(value)); };
        branch.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") open(true); });
        branch.addEventListener("pointerleave", event => { if (event.pointerType !== "touch" && !branch.contains(document.activeElement)) open(false); });
        branch.addEventListener("focusin", () => open(true));
        branch.addEventListener("focusout", event => { if (!branch.contains(event.relatedTarget)) open(false); });
        branch.addEventListener("keydown", event => {
          if (event.key === "ArrowRight" && event.target === parent) { event.preventDefault(); event.stopPropagation(); open(true); submenu.querySelector("button")?.focus(); }
          if ((event.key === "ArrowLeft" && submenu.contains(event.target)) || (id === "steel-calculator-navigation" && event.key === "Escape" && !submenu.hidden)) { event.preventDefault(); event.stopPropagation(); parent.focus(); open(false); }
        });
      }
    }
    setupSectionNavigation("estimate-navigation", "[data-estimator-kind]", open => setSectionMenuOpen("estimate-navigation", open), choice => requestEstimateNavigation(choice.dataset.estimatorKind));
    setupSectionNavigation("calculator-navigation", "[data-calculator-id]", setCalculatorMenuOpen, choice => requestCalculatorNavigation(choice.dataset.calculatorId));
    setupSectionNavigation("library-navigation", "[data-library-kind]", open => setSectionMenuOpen("library-navigation", open), choice => requestLibraryNavigation(choice.dataset.libraryKind));
    setupSectionNavigation("takeoff-navigation", "[data-mode]", open => setSectionMenuOpen("takeoff-navigation", open), choice => requestTakeoffNavigation(choice.dataset.mode, choice.dataset.physicalScope));
    setupSectionNavigation("projects-navigation", "[data-project-section]", open => setSectionMenuOpen("projects-navigation", open), choice => requestViewNavigation(choice.dataset.projectSection));
    setupSectionNavigation("documents-navigation", "[data-document-section]", open => setSectionMenuOpen("documents-navigation", open), choice => requestViewNavigation(choice.dataset.documentSection));
    setupSectionNavigation("settings-navigation", "[data-settings-action]", open => setSectionMenuOpen("settings-navigation", open), choice =>
      choice.dataset.settingsAction === "sign-out" ? window.CeasefireScheduler.openSignOut($("settings-navigation-toggle")) : requestViewNavigation("settings"));
    setupSectionNavigation("contacts-navigation", "[data-contacts-section]", open => setSectionMenuOpen("contacts-navigation", open), async choice => {
      if (await requestViewNavigation("contacts")) await window.ClassifireContacts?.activate(choice.dataset.contactsSection);
    });
  }
  let takeoffNavigationPending = false;
  async function requestTakeoffNavigation(mode, scope) {
    if (takeoffNavigationPending || !state.takeoffsEnabled) return false;
    takeoffNavigationPending = true;
    try {
      document.activeElement?.blur?.();
      if (state.currentView !== "takeoffs" && !await confirmLeavePricingLibrary()) return false;
      const changed = await window.CeasefireTakeoffs?.selectWorkspace(mode, scope);
      if (changed) {
        // An in-section choice already updates the workspace. Reopening the
        // section would rerender its unchanged PDF and record redundant proofs.
        if (state.currentView !== "takeoffs") await showView("takeoffs");
        window.CeasefireHeaderTagline?.next();
      }
      return !!changed && state.currentView === "takeoffs";
    } finally { takeoffNavigationPending = false; }
  }
  async function requestLibraryNavigation(kind, selection) {
    if (!["pricing", "penetration", "technical"].includes(kind)) return false;
    if ((state.currentView !== "pricing" || kind !== state.libraryKind) && !await confirmLeavePricingLibrary()) return false;
    state.libraryKind = kind;
    await showView("pricing", selection);
    if (state.currentView === "pricing") window.CeasefireHeaderTagline?.next();
    return state.currentView === "pricing";
  }
  async function requestPricingScopeSwitch(scope) {
    const previous = state.pricingScope;
    if (scope === previous) return true;
    $("pricing-scope").value = previous;
    if (!await confirmLeavePricingLibrary()) return false;
    switchPricingScope(scope); return true;
  }
  function projectPricingChanged() { return draftChanged(state.pricingScope === "project" ? state.draft : state.projectPricingDraft, state.quoteConfiguration || state.configuration); }
  function projectHasChanges() {
    if (JSON.stringify(projectFollowUp.actions) !== JSON.stringify(savedProjectFollowUp.actions)) return true;
    if (editingEstimateName && $("project-estimate-current-name").value.trim() !== editingEstimateName.name) return true;
    return state.estimatesDirty || window.ClassifirePassiveRegister?.hasProjectChanges() || window.CeasefireSWMS?.hasProjectChanges?.() || window.CeasefireCommercial?.hasProjectChanges?.() || state.projectStatus !== (state.projectFile?.project_status || "New") || window.CeasefireDownloads?.hasUnsavedProjectSave?.() || state.dirty || projectPricingChanged() || window.CeasefireCalculators?.hasUnsavedChanges() || window.CeasefirePenetrations?.hasUnsavedChanges() || window.CeasefireTakeoffs?.hasUnsavedChanges() || window.CeasefireLibraryEditor?.hasProjectChanges?.() || window.CeasefireCertification?.hasProjectChanges?.() || window.CeasefireDocumentation?.hasProjectChanges?.();
  }
  function pricingScopeUi() {
    $("pricing-scope").value = state.pricingScope;
    const save = $("save-pricing"), project = state.pricingScope === "project";
    window.CeasefireI18n.text($("save-pricing-label"), project ? "Apply" : "Save pricing");
    window.CeasefireI18n.attr(save, "title", project ? "Apply project pricing" : "Save pricing");
    window.CeasefireI18n.attr(save, "aria-label", project ? "Apply project pricing" : "Save pricing");
  }
  function switchPricingScope(scope) {
    document.activeElement?.blur?.();
    if (scope === state.pricingScope) return;
    if (state.pricingScope === "project") state.projectPricingDraft = state.draft; else state.libraryDraft = state.draft;
    state.pricingScope = scope; ++state.pricingRevision;
    state.draft = scope === "project" ? state.projectPricingDraft ||= clone(state.quoteConfiguration || state.configuration) : state.libraryDraft ||= clone(state.configuration);
    pricingScopeUi(); refreshPricingCatalog(); renderPricing();
  }
  function resetProjectPricing(scope = state.pricingScope) {
    if (state.pricingScope === "library") state.libraryDraft = state.draft;
    state.projectPricingDraft = clone(state.quoteConfiguration || state.configuration);
    state.pricingScope = scope; ++state.pricingRevision;
    state.draft = scope === "project" ? state.projectPricingDraft : state.libraryDraft ||= clone(state.configuration);
    pricingScopeUi(); refreshPricingCatalog(); renderPricing();
  }

  async function previewProjectPricing() {
    document.activeElement?.blur?.();
    const draft = state.pricingScope === "project" ? state.draft : state.projectPricingDraft;
    if (!draft) return;
    if (pricingInputProblem(draft)) throw new Error(pricingInputProblem(draft));
    if (!draftChanged(draft, state.quoteConfiguration || state.configuration)) return;
    const captured = JSON.stringify(draft), context = state.quoteContext;
    const data = await request("/api/configuration/preview", { method: "POST", body: JSON.stringify({ configuration: clone(draft) }) });
    const currentDraft = state.pricingScope === "project" ? state.draft : state.projectPricingDraft;
    if (context !== state.quoteContext || currentDraft !== draft || captured !== JSON.stringify(draft) || pricingHasPendingInput(draft)) throw new Error("Project pricing changed while being checked. Apply it again when ready.");
    return data;
  }

  function savePricingStamp() {
    const project = state.pricingScope === "project" ? state.draft : state.projectPricingDraft, library = sharedPricingDraft();
    return JSON.stringify([state.quoteConfiguration || state.configuration, project, project ? [...pricingPendingFields(project)] : [], library, library ? [...pricingPendingFields(library)] : [], state.pricingScope]);
  }
  function chooseProjectSavePricing() {
    const answer = confirmationQueue.then(() => new Promise(resolve => {
      const dialog = $("discard-dialog"), library = uiNode("button", "button secondary", "Use library draft for this project");
      library.type = "button"; library.addEventListener("click", () => dialog.close("library"));
      window.CeasefireI18n.text(dialog.querySelector("h2"), "Which prices should this project save?");
      window.CeasefireI18n.text(dialog.querySelector("p"), "Current project pricing and the Pricing Library draft have different edits. Choose the prices for this project file. The other draft will be kept, and the shared library will stay unchanged.");
      window.CeasefireI18n.text(dialog.querySelector('[value="cancel"]'), "Cancel save");
      window.CeasefireI18n.text(dialog.querySelector('[value="confirm"]'), "Use project pricing");
      dialog.querySelector(".actions").append(library);
      dialog.addEventListener("close", () => { library.remove(); resolve(dialog.returnValue === "confirm" ? "project" : dialog.returnValue === "library" ? "library" : null); }, { once: true });
      dialog.returnValue = "cancel"; dialog.showModal();
    }));
    confirmationQueue = answer.catch(() => {}); return answer;
  }
  async function previewSavePricing() {
    const project = state.pricingScope === "project" ? state.draft : state.projectPricingDraft, library = sharedPricingDraft();
    const projectChanged = projectPricingChanged(), libraryChanged = sharedPricingChanged(), captured = savePricingStamp(), context = state.quoteContext;
    let scope = libraryChanged ? "library" : "project";
    const conflict = projectChanged && libraryChanged && JSON.stringify(project) !== JSON.stringify(library);
    if (conflict) { scope = await chooseProjectSavePricing(); if (!scope) throw new Error("Save cancelled. Both pricing drafts were kept."); }
    if (context !== state.quoteContext || captured !== savePricingStamp()) throw new Error("Pricing changed while choosing the project prices. Save again when ready.");
    const draft = scope === "library" ? library : project;
    if (!draft || !projectChanged && !libraryChanged) return;
    if (pricingInputProblem(draft)) throw new Error(pricingInputProblem(draft));
    const data = await request("/api/configuration/preview", { method: "POST", body: JSON.stringify({ configuration: clone(draft) }) });
    if (context !== state.quoteContext || captured !== savePricingStamp() || pricingHasPendingInput(draft)) throw new Error("Pricing changed while being checked. Save again when ready.");
    return { ...data, scope, conflict, unchosenProjectDraft: conflict && scope === "library" ? project : null };
  }

  async function applyProjectPricing() {
    const data = await previewProjectPricing();
    if (!data) return;
    state.quoteConfiguration = clone(data.configuration); state.fields = clone(data.fields);
    state.projectPricingDraft = clone(data.configuration);
    if (state.pricingScope === "project") { state.draft = state.projectPricingDraft; refreshPricingCatalog(); renderPricing(); }
    renderInputs(); updateDirty(); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
    $("snapshot-message").hidden = false;
    window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "This project uses its own pricing. Save retains these prices in its file.");
  }

  async function useCurrentPricing() {
    if (state.projectBusy) return;
    const context = state.quoteContext, target = state.projectFile, pricing = savePricingStamp();
    if (projectPricingChanged() && !await confirmReplace(uiCopy("Use current library prices?"), uiCopy("The project's pricing edits will be replaced with the last saved shared library."), uiCopy("Use current pricing"))) return;
    if (state.projectBusy || context !== state.quoteContext || target !== state.projectFile || pricing !== savePricingStamp()) return;
    state.quoteConfiguration = clone(state.configuration); state.fields = clone(state.currentFields);
    resetProjectPricing(); renderInputs(); updateDirty(); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
    $("snapshot-message").hidden = false;
    window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "Current saved library applied. Save to retain these prices.");
    message(uiCopy("Current saved library applied to this project. Check any removed product selections, then Save."));
  }

  function setOverride(kind, item, field, value) {
    state.draft[kind] ||= {};
    state.draft[kind][item.id] ||= {};
    const baseValue = kind === "rates" && field === "price" ? rateDefaultPrice(item)
      : field === "supplier_price" ? (kind === "inventory" && item.pricing_mode === "manual" ? item.sales_price : item.supplier_price ?? item.price)
      : field === "markup" ? (kind === "inventory" && item.pricing_mode === "manual" ? 0 : item.markup ?? 0) : item[field];
    if ((value === "" && !["yield", "pricing_yield", "manufacturer"].includes(field)) || value === baseValue) delete state.draft[kind][item.id][field];
    else state.draft[kind][item.id][field] = value;
    if (!Object.keys(state.draft[kind][item.id]).length) delete state.draft[kind][item.id];
    markPricingDirty();
  }

  function priceInput(kind, item, key, options = {}) {
    const input = node("input", options.text ? "item-name" : "");
    input.type = options.text ? "text" : "number";
    input.step = "0.01";
    input.dataset.priceField = key;
    const current = getOverride(kind, item.id)[key] ?? options.defaultValue ?? item[key] ?? "";
    input.value = options.text ? current : controlValue(current, options.percent);
    window.CeasefireI18n.attr(input, "aria-label", "{0}: {1}{2}", [item.name, window.CeasefireI18n.term(options.label || key), window.CeasefireI18n.term(options.percent ? " in percent" : "")]);
    input.addEventListener("input", () => {
      let value = input.value;
      if (!options.text) value = editedNumber(input, options.percent);
      if (["supplier_price", "markup"].includes(key)) {
        const legacyKey = kind === "inventory" ? "sales_price" : "price";
        const prior = getOverride(kind, item.id);
        if (Object.hasOwn(prior, legacyKey)) {
          const price = prior[legacyKey]; delete prior[legacyKey];
          setOverride(kind, item, "supplier_price", price); setOverride(kind, item, "markup", 0);
        }
      }
      setOverride(kind, item, key, value);
      const row = input.closest("tr");
      row.classList.toggle("edited", !!state.draft[kind][item.id]);
      const output = row.querySelector("[data-sell-preview]");
      if (output) output.textContent = formatMoney(kind === "inventory" ? inventorySellPrice(item) : rateSellPrice(item));
      options.onChange?.();
    });
    if (!options.text) input.addEventListener("blur", () => {
      // Formatting the visible input does not add an override or round a rate.
      if (input.value !== "" && !input.validity.badInput && Number.isFinite(Number(input.value))) input.value = controlValue(Number(input.value));
    });
    return input;
  }

  function inventorySellPrice(item) {
    const override = getOverride("inventory", item.id);
    if (Object.hasOwn(override, "sales_price")) return override.sales_price;
    if (Object.hasOwn(override, "supplier_price") || Object.hasOwn(override, "markup")) {
      const supplier = override.supplier_price ?? (item.pricing_mode === "manual" ? item.sales_price : item.supplier_price);
      return isNumber(supplier) ? supplier * (1 + (override.markup ?? (item.pricing_mode === "manual" ? 0 : item.markup) ?? 0)) : item.sales_price;
    }
    return item.sales_price;
  }

  function rateSellPrice(item) {
    const override = getOverride("rates", item.id);
    if (Object.hasOwn(override, "price")) return override.price;
    if (Object.hasOwn(override, "supplier_price") || Object.hasOwn(override, "markup")) return (override.supplier_price ?? item.supplier_price ?? rateDefaultPrice(item)) * (1 + (override.markup ?? item.markup ?? 0));
    return rateDefaultPrice(item);
  }

  function rateDefaultPrice(item) {
    const inventory = state.catalog.inventory.find((record) => record.id === item.inventory_id);
    const inventoryOverride = inventory ? getOverride("inventory", inventory.id) : {};
    if (item.price_mode !== "override" && inventory && ["supplier_price", "markup", "sales_price"].some((field) => Object.hasOwn(inventoryOverride, field))) return inventorySellPrice(inventory);
    return item.price;
  }

  function refreshPricingCatalog() {
    state.catalog = clone(state.draft.catalog || state.baseline);
    const selection = $("rate-group").value;
    const firestopping = state.pricingUsage?.firestopping || {};
    const options = [["", "All estimator availability"], ["main-estimator", "Main Estimator"],
      ...Object.keys(state.catalog.rate_groups || {}).map((key) => [key, uiCopy("Main Estimator — {0}", [key])]),
      ["firestopping", firestopping.label || "Firestopping Estimator"],
      ...(firestopping.groups || []).map((group) => [`firestopping:${group.key}`, uiCopy("Firestopping Estimator — {0}", [group.key])]),
      ["not-used", "Not used in either estimator"]].map(([key, label]) => {
      const option = node("option"); uiText(option, label); option.value = key; return option;
    });
    $("rate-group").replaceChildren(...options);
    $("rate-group").value = options.some((option) => option.value === selection) ? selection : "";
  }

  function resetButton(kind, item) {
    const button = node("button", "button secondary icon-only pricing-reset-button reset-button");
    const icon = node("span", "button-symbol pricing-action-symbol pricing-reset-symbol");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 7v5h-5"></path><path d="M4 17v-5h5"></path><path d="M6.1 8.4A7.5 7.5 0 0 1 19.2 10L20 12"></path><path d="M17.9 15.6A7.5 7.5 0 0 1 4.8 14L4 12"></path></svg>';
    button.append(icon, uiNode("span", "sr-only", "Reset row"));
    button.type = "button";
    const saved = pricingBaseline(), savedCatalog = saved.catalog || state.baseline;
    const ownRate = (rate) => kind === "inventory" ? rate.inventory_id === item.id : rate.id === item.id;
    const original = kind === "inventory" ? savedCatalog.inventory.find((entry) => entry.id === item.id)
      : Object.values(savedCatalog.rate_groups).flat().find(ownRate);
    button.disabled = !original;
    window.CeasefireI18n.attr(button, "aria-label", "Restore saved values and estimator uses for {0}", [item.name]);
    window.CeasefireI18n.attr(button, "title", "Restore saved values and estimator uses for {0}", [item.name]);
    button.addEventListener("click", () => {
      if (!original) return;
      const affectedRates = new Set([...Object.values(state.catalog.rate_groups).flat(), ...Object.values(savedCatalog.rate_groups).flat()].filter(ownRate).map((rate) => rate.id));
      editPricingCatalog((catalog) => {
        if (kind === "inventory") catalog.inventory[catalog.inventory.findIndex((entry) => entry.id === item.id)] = clone(original);
        for (const [group, rates] of Object.entries(catalog.rate_groups)) {
          catalog.rate_groups[group] = rates.filter((rate) => !ownRate(rate));
          savedCatalog.rate_groups[group].forEach((rate, index) => {
            if (ownRate(rate)) catalog.rate_groups[group].splice(Math.min(index, catalog.rate_groups[group].length), 0, clone(rate));
          });
        }
      });
      if (kind === "inventory") {
        delete state.draft.inventory[item.id];
        if (saved.inventory?.[item.id]) state.draft.inventory[item.id] = clone(saved.inventory[item.id]);
      }
      for (const id of affectedRates) {
        delete state.draft.rates[id];
        if (saved.rates?.[id]) state.draft.rates[id] = clone(saved.rates[id]);
      }
      if (JSON.stringify(state.draft.catalog) === JSON.stringify(savedCatalog)) {
        if (!saved.catalog) delete state.draft.catalog;
        if (saved.catalog_signature) state.draft.catalog_signature = saved.catalog_signature;
      }
      for (const key of pricingPendingFields().keys()) if (key.startsWith(`${kind}:${item.id}:`)) pricingPendingFields().delete(key);
      refreshPricingCatalog(); markPricingDirty(); renderPricing();
    });
    return button;
  }

  const pricingFieldDrafts = new WeakMap();
  function pricingPendingFields(draft = state.draft) {
    if (!pricingFieldDrafts.has(draft)) pricingFieldDrafts.set(draft, new Map());
    return pricingFieldDrafts.get(draft);
  }
  function pricingInputProblem(draft = state.draft) {
    return [...pricingPendingFields(draft).values()].find((entry) => entry.error)?.error || "";
  }
  function pricingHasPendingInput(draft = state.draft) { return pricingPendingFields(draft).size > 0; }
  function pricingUseList(values) {
    return values.map((value) => /[;"\n\r]|^\s|\s$/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")).join("; ");
  }
  function parsePricingUses(text) {
    if (!text.trim()) return [];
    const values = []; let value = "", quoted = false, closed = false, quotedField = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
        else if (char === '"') { quoted = false; closed = true; }
        else value += char;
      } else if (char === ";") { values.push(quotedField ? value : value.trim()); value = ""; closed = false; quotedField = false; }
      else if (char === '"' && !value.trim() && !closed) { quoted = true; quotedField = true; value = ""; }
      else if (char === '"' || (closed && char.trim())) throw new Error("Use semicolons between values and double quotes around a name containing a semicolon.");
      else if (!closed) value += char;
    }
    if (quoted) throw new Error("Close the quoted value before continuing.");
    values.push(quotedField ? value : value.trim()); return values;
  }
  function pricingYieldUnit(group, rate) {
    return (rate.uses_yield ?? !!rate.source?.yield) ? (group === "mastic" ? "m / unit" : "m² / unit") : "";
  }
  function editPricingCatalog(edit) {
    const catalog = clone(state.draft.catalog || state.catalog);
    edit(catalog);
    state.draft.catalog = catalog;
    delete state.draft.catalog_signature;
    refreshPricingCatalog();
    markPricingDirty();
  }
  function addPricingItem() {
    document.activeElement?.blur?.();
    const ids = new Set((state.catalog.inventory || []).map((item) => item.id));
    let number = 1, id;
    do { id = `inv-user-${String(number++).padStart(6, "0")}`; } while (ids.has(id));
    editPricingCatalog((catalog) => {
      catalog.inventory.push({
        id, item_code: "", name: "New pricing item", sales_description: "",
        product_service: "New pricing item", supplier_price: 0, supplier_price_raw: "",
        sales_price: 0, calculated_sell_price: 0, pricing_mode: "supplier_markup",
        markup: isNumber(catalog.markup) ? catalog.markup : 0, status: "Active",
        inventory_type: "", properties: {}, source: { origin: "user" },
        firestopping_groups: [],
      });
    });
    $("pricing-search").value = ""; $("rate-group").value = ""; renderPricing();
    const addedRow = $("pricing-body").querySelector(`[data-price-id="${id}"]`);
    addedRow?.scrollIntoView?.({ block: "center", behavior: "instant" });
    const firstInput = addedRow?.querySelector("input,textarea,select"); firstInput?.focus({ preventScroll: true }); firstInput?.select?.();
    message(uiCopy("New pricing item added to the draft. Complete its details and estimator groups, then save pricing."));
  }
  async function removePricingItem(record) {
    document.activeElement?.blur?.();
    const itemName = productServiceName(record) || record.item.name || record.item.id;
    const linkedRates = record.kind === "inventory" ? record.uses.map(({ item }) => item.id) : [record.item.id];
    const detail = record.kind === "inventory" && linkedRates.length
      ? `${itemName} and its ${linkedRates.length} linked estimator ${linkedRates.length === 1 ? "use" : "uses"} will be removed from this pricing draft.`
      : `${itemName} will be removed from this pricing draft.`;
    const draft = state.draft, fingerprint = JSON.stringify(draft);
    if (!await confirmReplace(uiCopy("Remove pricing item?"), detail, uiCopy("Remove item"))) return;
    if (state.draft !== draft || JSON.stringify(state.draft) !== fingerprint) {
      message(uiCopy("Pricing changed during removal confirmation. Review the current draft and try again."), true); return;
    }
    editPricingCatalog((catalog) => {
      if (record.kind === "inventory") catalog.inventory = catalog.inventory.filter((item) => item.id !== record.item.id);
      for (const group of Object.keys(catalog.rate_groups)) catalog.rate_groups[group] = catalog.rate_groups[group].filter((rate) => !linkedRates.includes(rate.id));
    });
    if (record.kind === "inventory") delete state.draft.inventory[record.item.id];
    for (const id of linkedRates) delete state.draft.rates[id];
    const saved = pricingBaseline(), savedCatalog = saved.catalog || state.baseline;
    if (JSON.stringify(state.draft.catalog) === JSON.stringify(savedCatalog)) {
      if (!saved.catalog) delete state.draft.catalog;
      if (saved.catalog_signature) state.draft.catalog_signature = saved.catalog_signature;
    }
    for (const key of [...pricingPendingFields().keys()]) {
      if (key.startsWith(`${record.kind}:${record.item.id}:`) || linkedRates.some((id) => key.startsWith(`rates:${id}:`))) pricingPendingFields().delete(key);
    }
    renderPricing(); message(uiCopy("{0} removed from the pricing draft. Save pricing to keep this change.", [itemName]));
  }
  function pricingFieldInput(record, field, initial, apply, placeholder = "", multiline = false) {
    const input = node(multiline ? "textarea" : "input", "pricing-use-list");
    if (multiline) input.rows = 2; else input.type = "text";
    const key = `${record.key}:${field}`;
    input.dataset.priceField = field;
    input.value = pricingPendingFields().get(key)?.value ?? initial;
    input.placeholder = placeholder;
    window.CeasefireI18n.attr(input, "aria-label", "{0}: {1}", [record.item.name, window.CeasefireI18n.term(field)]);
    const invalid = pricingPendingFields().get(key)?.error;
    if (invalid) { input.setCustomValidity?.(invalid); input.setAttribute("aria-invalid", "true"); }
    input.addEventListener("input", () => {
      pricingPendingFields().set(key, { value: input.value, error: "Finish editing the pricing field before saving." });
      markPricingDirty();
    });
    input.addEventListener("change", () => {
      try {
        const changed = input.value !== initial;
        if (changed) apply(input.value);
        pricingPendingFields().delete(key);
        input.setCustomValidity?.(""); input.removeAttribute("aria-invalid");
        markPricingDirty(); renderPricing();
        if (changed && field.endsWith("Estimator groups")) message(uiCopy(state.pricingScope === "project"
          ? "Estimator groups changed in this project draft. Click Apply project pricing to update this project's dropdowns, then Save to store them."
          : "Estimator groups changed in the shared library draft. Click Save pricing to update dropdowns for new estimates. Existing projects keep their saved groups."));
      } catch (error) {
        const text = `${record.item.name}: ${error.message}`;
        pricingPendingFields().set(key, { value: input.value, error: text });
        input.setCustomValidity?.(text); input.setAttribute("aria-invalid", "true"); message(text, true); markPricingDirty();
      }
    });
    return input;
  }
  function pricingListInput(record, field, values, apply, placeholder = "") {
    return pricingFieldInput(record, field, pricingUseList(values), (text) => apply(parsePricingUses(text)), placeholder);
  }
  function productServiceName(record) {
    const product = { ...record.item, ...getOverride(record.kind, record.item.id) };
    if (product.product_service) return product.product_service;
    const rates = record.uses.map(({ item }) => ({ ...item, ...getOverride("rates", item.id) }));
    const explicit = rates.find((rate) => rate.product_service);
    if (explicit) return explicit.product_service;
    const candidates = [...(record.kind === "inventory" ? [product.sales_description, product.name] : []), ...rates.flatMap((rate) => [rate.display_name, rate.name])].filter((text) => typeof text === "string" && text.trim());
    return candidates.reduce((best, text) => text.trim().length > best.trim().length ? text : best, "");
  }

  function firestoppingGroups(record) {
    if (record.kind !== "inventory") return [];
    if (Array.isArray(record.item.firestopping_groups)) return record.item.firestopping_groups.map(key => key === "mastics" ? "mastic" : key);
    const metadata = state.pricingUsage?.firestopping || {};
    const source = String(record.item[metadata.source_field || "sales_description"] || "").toLocaleLowerCase();
    return (metadata.groups || []).filter((group) => (group.keywords || []).some((keyword) => source.includes(String(keyword).toLocaleLowerCase()))).map((group) => group.key);
  }
  function usedInFirestopping(record) {
    return firestoppingGroups(record).length > 0;
  }
  function setFirestoppingGroups(record, labels) {
    if (record.kind !== "inventory") throw new Error("Firestopping groups can only be assigned to inventory products.");
    if (labels.length === 1 && labels[0] === "") labels = [];
    const available = state.pricingUsage?.firestopping?.groups || [];
    const selected = labels.map((name) => {
      const key = name.toLowerCase() === "mastics" ? "mastic" : name.toLowerCase();
      return available.find(group => group.key === key || group.label.toLowerCase() === key);
    });
    if (selected.some((group) => !group)) throw new Error(`Choose existing Firestopping groups: ${available.map((group) => group.key).join("; ")}.`);
    const keys = selected.map((group) => group.key);
    if (new Set(keys).size !== keys.length) throw new Error("Enter each Firestopping group once.");
    editPricingCatalog((catalog) => { catalog.inventory.find((item) => item.id === record.item.id).firestopping_groups = keys; });
  }
  function setProductService(record, text) {
    if (!text.trim() || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Product/Service must contain 1 to 1,000 characters without unsupported control characters.");
    setOverride(record.kind, record.item, "product_service", text);
  }
  function setManufacturer(record, text) {
    const value = text.trim();
    if (value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(uiCopy("Manufacturer must contain at most 200 characters without control characters."));
    setOverride(record.kind, record.item, "manufacturer", value);
  }
  function sharedPricingYield(record) {
    const uses = record.uses.filter(({ item }) => item.uses_yield ?? !!item.source?.yield);
    const values = uses.map(({ item }) => Object.hasOwn(getOverride("rates", item.id), "yield") ? getOverride("rates", item.id).yield : item.yield);
    const units = [...new Set(uses.map(({ group, item }) => pricingYieldUnit(group, item)))];
    const mixed = values.some((value) => value !== values[0]);
    // Both stored blank kinds look empty; retain their distinct calculation
    // values until the user actually edits the yield.
    const override = getOverride(record.kind, record.item.id);
    const stored = Object.hasOwn(override, "pricing_yield") ? override.pricing_yield : record.item.pricing_yield;
    const value = !values.length ? (stored ?? "") : mixed ? "Mixed" : values[0] === null || values[0] === "" ? "" : String(values[0]);
    return { uses, values, units, mixed, value };
  }
  function setSharedPricingYield(record, text) {
    const shared = sharedPricingYield(record), token = text.trim().toLowerCase();
    let value;
    if (!token || token === "blank") value = null;
    else if (token === "empty text") value = "";
    else {
      if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(token) || !Number.isFinite(Number(token)) || Number(token) > 1e12) throw new Error("Yield must be one nonnegative number or left blank. Semicolon lists are not needed.");
      value = Number(token);
    }
    if (!shared.uses.length) setOverride(record.kind, record.item, "pricing_yield", value);
    for (const { item } of shared.uses) setOverride("rates", item, "yield", value);
  }
  function setPricingUses(record, labels) {
    const categories = Object.keys(state.catalog.rate_groups);
    const sharedYield = sharedPricingYield(record);
    const selected = labels.map((label) => categories.find((key) => key.toLowerCase() === label.toLowerCase() || (groups[key] || key).toLowerCase() === label.toLowerCase()));
    if (selected.some((group) => !group)) throw new Error(`Choose existing uses: ${categories.join("; ")}.`);
    if (record.kind !== "inventory" && selected.length !== 1) throw new Error("A standalone rate needs exactly one use.");
    const retained = new Set(), removed = [];
    editPricingCatalog((catalog) => {
      const old = record.uses.map((use) => ({ group: use.group, item: clone(use.item) }));
      const matched = selected.map((group) => {
        const match = old.find((use) => use.group === group && !retained.has(use.item.id));
        if (match) { retained.add(match.item.id); return match; }
        return { group, item: null };
      });
      for (const use of old) if (!retained.has(use.item.id)) removed.push(use.item.id);
      for (const group of categories) catalog.rate_groups[group] = catalog.rate_groups[group].filter((rate) => !removed.includes(rate.id));
      for (const use of matched) {
        if (use.item) continue;
        const template = old.find((entry) => removed.includes(entry.item.id));
        const usesYield = Boolean(catalog.rate_group_rules?.[use.group]?.yield_column) || catalog.rate_groups[use.group].some((rate) => rate.uses_yield);
        const item = record.kind === "rates" && template ? clone(template.item) : {
          id: `rate_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`,
          name: getOverride(record.kind, record.item.id).name || record.item.name,
          inventory_id: record.kind === "inventory" ? record.item.id : null,
          price: record.kind === "inventory" ? inventorySellPrice(record.item) : rateSellPrice(record.item),
          price_mode: record.kind === "inventory" ? "inventory" : "override", source: {},
        };
        let name = item.name, suffix = 2;
        while (catalog.rate_groups[use.group].some((rate) => rate.name.toLowerCase() === name.toLowerCase())) name = `${item.name} (${suffix++})`;
        item.name = name; item.uses_yield = usesYield;
        item.yield = usesYield && !sharedYield.mixed && sharedYield.units.length === 1 && sharedYield.units[0] === pricingYieldUnit(use.group, item) ? sharedYield.values[0] : null;
        // Reuse a single compatible yield, never reinterpret area as length.
        delete item.yield_unit;
        catalog.rate_groups[use.group].push(item);
      }
    });
    for (const id of removed) if (!Object.values(state.catalog.rate_groups).some((rates) => rates.some((rate) => rate.id === id))) delete state.draft.rates[id];
  }
  async function resetPricingLibrary() {
    document.activeElement?.blur?.();
    const scope = state.pricingScope, draft = state.draft, snapshot = JSON.stringify(draft), pending = JSON.stringify([...pricingPendingFields(draft)]);
    const saveAction = scope === "project" ? "Apply project pricing" : "Save pricing";
    if (!await confirmReplace(uiCopy(scope === "project" ? "Reset project pricing?" : "Reset Library?"), uiCopy("Replace this pricing draft with the application's original products, rates and yields. Click {0} to keep these defaults. Existing project files keep their own pricing.", [window.CeasefireI18n.term(saveAction)]), uiCopy("Reset Library"))) return;
    if (state.pricingScope !== scope || state.draft !== draft || JSON.stringify(state.draft) !== snapshot || JSON.stringify([...pricingPendingFields(draft)]) !== pending) {
      message(uiCopy("Pricing changed during reset confirmation. Review the current pricing draft and try Reset Library again."), true); return;
    }
    state.draft = { catalog: clone(state.baseline), inventory: {}, rates: {} }; refreshPricingCatalog(); renderPricing();
    message(uiCopy("Original library defaults are ready as a draft. Click {0} to keep them, or Discard changes to restore the {1}.", [window.CeasefireI18n.term(saveAction), window.CeasefireI18n.term(scope === "project" ? "last applied project pricing" : "last saved library")]));
  }

  function pricingViewState() {
    // Retain the controls when navigation has changed no pricing data. Include
    // values, not just object identities: edits and saved baselines can change
    // in place. Pending field text already belongs to the retained controls.
    // Replacement objects still need fresh controls: handlers capture records,
    // and pending field drafts belong to one specific pricing draft object.
    const references = [state.draft, state.catalog, pricingBaseline(), state.baseline];
    return { references, key: JSON.stringify([references, state.pricingScope,
      $("pricing-search").value, $("rate-group").value]) };
  }

  function pricingViewCurrent() {
    if (!state.pricingRender) return false;
    const current = pricingViewState();
    return current.key === state.pricingRender.key && current.references.every((value, index) => value === state.pricingRender.references[index]);
  }

  function renderPricing() {
    if (state.currentView !== "pricing" || state.libraryKind !== "pricing") {
      state.pricingRender = null;
      if ($("pricing-body").childElementCount) $("pricing-body").replaceChildren();
      markPricingDirty();
      return;
    }
    const search = $("pricing-search").value.trim().toLocaleLowerCase();
    const selectedGroup = $("rate-group").value;
    const records = (state.catalog.inventory || []).map((item) => ({ kind: "inventory", item, uses: [], key: `inventory:${item.id}` }));
    const products = new Map(records.map((record) => [record.item.id, record]));
    for (const [group, rates] of Object.entries(state.catalog.rate_groups || {})) for (const item of rates) {
      const use = { group, item }, product = products.get(item.inventory_id);
      if (product) product.uses.push(use);
      else records.push({ kind: "rates", item, uses: [use], key: `rates:${item.id}` });
    }
    const productText = (record) => `${productServiceName(record)} ${record.item.name} ${record.item.sales_description || ""} ${record.item.item_code || ""} ${getOverride(record.kind, record.item.id).manufacturer ?? record.item.manufacturer ?? ""}`.toLocaleLowerCase();
    const matches = records.filter((record) => {
      const firestopping = usedInFirestopping(record);
      const groupMatch = !selectedGroup || (selectedGroup === "main-estimator" ? record.uses.length > 0
        : selectedGroup === "firestopping" ? firestopping
        : selectedGroup.startsWith("firestopping:") ? firestoppingGroups(record).includes(selectedGroup.slice("firestopping:".length))
        : selectedGroup === "not-used" ? !record.uses.length && !firestopping
        : record.uses.some((use) => use.group === selectedGroup));
      const firestoppingText = firestoppingGroups(record).join(" ");
      const useText = `${record.uses.map(({ group, item }) => `${group} ${groups[group] || ""} ${item.name} ${item.display_name || ""}`).join(" ")} ${firestoppingText}`.toLocaleLowerCase();
      return groupMatch && `${productText(record)} ${useText}`.includes(search);
    });
    window.CeasefireI18n.text($("pricing-count"), "{0} of {1} products and standalone rates", [matches.length, records.length]);
    const heading = node("tr");
    for (const title of ["Product/Service", "Manufacturer", "Supplier price", "Markup %", "Sell price", "Main Estimator groups", "Firestopping Estimator groups", "Yield", "Actions"])
      heading.append(uiNode("th", "", title));
    $("pricing-head").replaceChildren(heading);
    const refreshers = [], refreshPrices = () => refreshers.forEach((refresh) => refresh());
    const rows = [];
    for (const record of matches) {
      const { item, kind, uses } = record, inventoryView = kind === "inventory";
      const row = node("tr", state.draft[kind]?.[item.id] ? "edited" : "");
      row.dataset.priceId = item.id; row.dataset.priceKind = kind;
      const nameCell = node("td");
      nameCell.append(pricingFieldInput(record, "Product/Service", productServiceName(record), (text) => setProductService(record, text), "", true));
      row.append(nameCell);
      const manufacturerCell = node("td");
      const manufacturer = pricingFieldInput(record, "Manufacturer", getOverride(kind, item.id).manufacturer ?? item.manufacturer ?? "", (text) => setManufacturer(record, text));
      manufacturer.maxLength = 200;
      manufacturerCell.append(manufacturer); row.append(manufacturerCell);
      if (inventoryView) {
        const supplier = node("td");
        const markup = node("td");
        const legacyPrice = getOverride(kind, item.id).sales_price;
        supplier.append(priceInput(kind, item, "supplier_price", { defaultValue: legacyPrice ?? (item.pricing_mode === "manual" ? item.sales_price : item.supplier_price), label: "Supplier price", onChange: refreshPrices }));
        markup.append(priceInput(kind, item, "markup", { defaultValue: legacyPrice !== undefined || item.pricing_mode === "manual" ? 0 : item.markup, percent: true, label: "Markup", onChange: refreshPrices }));
        const sell = node("td"), output = node("span", "price-value", formatMoney(inventorySellPrice(item)));
        output.dataset.sellPreview = "true"; sell.append(output);
        row.append(supplier, markup, sell);
      } else {
        const supplier = node("td"), markup = node("td"), sell = node("td");
        supplier.append(priceInput(kind, item, "supplier_price", { defaultValue: getOverride(kind, item.id).price ?? item.supplier_price ?? rateSellPrice(item), label: "Supplier price", onChange: refreshPrices }));
        markup.append(priceInput(kind, item, "markup", { defaultValue: Object.hasOwn(getOverride(kind, item.id), "price") ? 0 : item.markup ?? 0, percent: true, label: "Markup", onChange: refreshPrices }));
        const output = node("span", "price-value", formatMoney(rateSellPrice(item))); output.dataset.sellPreview = "true"; sell.append(output);
        row.append(supplier, markup, sell);
      }
      const groupCell = node("td", "pricing-availability");
      groupCell.append(pricingListInput(record, "Main Estimator groups", uses.map(({ group }) => group), (values) => setPricingUses(record, values), "Not used in main Estimator"));
      const firestoppingCell = node("td", "pricing-availability");
      const firestoppingInput = pricingListInput(record, "Firestopping Estimator groups", firestoppingGroups(record), (values) => setFirestoppingGroups(record, values), inventoryView ? "Not used in Firestopping Estimator" : "Requires an inventory product");
      firestoppingInput.disabled = !inventoryView; firestoppingCell.append(firestoppingInput);
      row.append(groupCell, firestoppingCell);
      const shared = sharedPricingYield(record), yieldCell = node("td");
      const input = pricingFieldInput(record, "Yield", String(shared.value), (text) => setSharedPricingYield(record, text));
      input.title = shared.units.join("; ") || "Stored yield; not used by this item's current calculation groups";
      yieldCell.append(input);
      if (shared.mixed || shared.units.length > 1) yieldCell.append(uiNode("small", "subtext", "Different saved yields: enter one value to apply it to all uses."));
      row.append(yieldCell);
      const reset = node("td", "pricing-row-actions"), remove = node("button", "button secondary icon-only trash-button");
      remove.type = "button"; remove.dataset.pricingRemove = item.id; window.CeasefireI18n.attr(remove, "title", "Remove {0}", [productServiceName(record) || item.name]); window.CeasefireI18n.attr(remove, "aria-label", "Remove {0}", [productServiceName(record) || item.name]);
      const removeIcon = node("span", "trash-artwork"); removeIcon.setAttribute("aria-hidden", "true"); remove.append(removeIcon);
      remove.addEventListener("click", () => removePricingItem(record)); reset.append(resetButton(kind, item), remove); row.append(reset);
      rows.push(row);
    }
    if (!rows.length) { const row = node("tr"); const cell = uiNode("td", "empty-state", "No matching products or rates."); cell.colSpan = 9; row.append(cell); rows.push(row); }
    $("pricing-body").replaceChildren(...rows);
    refreshPrices();
    markPricingDirty();
    state.pricingRender = pricingViewState();
  }

  async function savePricing() {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    const button = $("save-pricing"); button.disabled = true;
    $("use-current-pricing").disabled = true;
    let persisted = false;
    try {
      if (state.pricingScope === "project") {
        await applyProjectPricing();
        message(uiCopy("Project pricing applied. Save to store it with the estimate and calculators."));
        return;
      }
      const draftObject = state.draft;
      const draft = clone(state.draft);
      const configuration = await request("/api/configuration", { method: "PUT", body: JSON.stringify(draft) });
      persisted = true;
      const metadata = await request("/api/bootstrap");
      // Keep prices and their dropdown definitions in step. Until both arrive,
      // estimates continue using the previously loaded pricing configuration.
      const previousConfiguration = state.configuration;
      state.configuration = clone(metadata.configuration || configuration);
      state.pricingUsage = clone(metadata.pricing_usage || state.pricingUsage);
      state.currentFields = clone(metadata.fields || state.currentFields);
      const unchanged = JSON.stringify(draftObject) === JSON.stringify(draft) && !pricingHasPendingInput(draftObject);
      if (state.libraryDraft === draftObject && unchanged) state.libraryDraft = clone(state.configuration);
      if (state.pricingScope === "library" && state.draft === draftObject && unchanged) state.draft = state.libraryDraft || clone(state.configuration);
      if (!state.quoteConfiguration) {
        state.fields = clone(state.currentFields);
        if (!draftChanged(state.projectPricingDraft, previousConfiguration)) {
          state.projectPricingDraft = clone(state.configuration);
          if (state.pricingScope === "project") state.draft = state.projectPricingDraft;
        }
        renderInputs(); updateDirty(); scheduleCalculation();
        window.CeasefirePenetrations?.pricingChanged();
      }
      refreshPricingCatalog(); renderPricing();
      const changedElsewhere = JSON.stringify(state.configuration) !== JSON.stringify(configuration);
      message(uiCopy(changedElsewhere ? "Pricing was saved, then changed in another session. The latest saved library is loaded; any further draft edits are still unsaved."
        : state.pricingDirty ? "Pricing saved. Changes made while saving are still unsaved." : "Pricing library saved. The saved products, choices and rates now apply to new estimates."));
    } catch (error) { message(persisted ? uiCopy("Pricing was saved, but the updated dropdowns could not be loaded. Reload the app before starting another estimate. {0}", [error.message]) : uiCopy("Pricing was not saved. {0}", [error.message]), true); }
    finally { button.disabled = false; $("use-current-pricing").disabled = false; }
  }

  async function requestSavePricing() {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    if (state.pricingScope === "project") return savePricing();
    const draft = state.draft, fingerprint = JSON.stringify(draft), pending = JSON.stringify([...pricingPendingFields(draft)]);
    if (!await confirmReplace(uiCopy("Save Pricing Library?"), uiCopy(pricingSavePrompt), uiCopy("Save"), uiCopy("Cancel"))) return;
    if (state.pricingScope !== "library" || state.draft !== draft || JSON.stringify(state.draft) !== fingerprint || JSON.stringify([...pricingPendingFields(draft)]) !== pending) {
      message(uiCopy("The Pricing Library changed while the confirmation was open. Review the current changes and click Save pricing again."), true);
      return;
    }
    return savePricing();
  }

  async function exportPricing(button = $("export-pricing")) {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    if (button.disabled) return;
    const draft = JSON.stringify(state.draft);
    button.disabled = true; button.setAttribute("aria-busy", "true"); window.CeasefireI18n.attr(button, "aria-label", "Exporting Excel…");
    try {
      const saved = await window.CeasefireDownloads.save("/api/pricing/export", { configuration: JSON.parse(draft) }, { button });
      message(saved.destination === "browser" ? uiCopy(draft === JSON.stringify(state.draft) ? "Pricing Library download prepared: {0}. It includes all inventory and rate groups, including your unsaved pricing edits." : "Pricing Library download prepared: {0}. Later edits are not included.", [saved.filename]) : draft === JSON.stringify(state.draft) ? uiCopy("Excel saved to {0}. It includes all inventory and rate groups, including your unsaved pricing edits.", [saved.path]) : uiCopy("Excel saved to {0} using the pricing captured when you clicked Export Excel. Later edits are not included.", [saved.path]));
      return saved;
    } catch (error) { message(uiCopy("Pricing was not exported. {0}", [error.message]), true); }
    finally { button.disabled = false; button.removeAttribute("aria-busy"); window.CeasefireI18n.attr(button, "aria-label", "Export Excel"); }
  }

  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("The selected file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function importPricing() {
    document.activeElement?.blur?.();
    if (pricingInputProblem()) { message(pricingInputProblem(), true); return; }
    const input = $("pricing-import-file");
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const button = $("import-pricing");
    const sourceDraft = state.draft, draft = JSON.stringify(sourceDraft);
    button.disabled = true; button.setAttribute("aria-busy", "true"); window.CeasefireI18n.attr(button, "aria-label", "Reading Excel…");
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an .xlsx workbook exported from this pricing library.");
      if (file.size > 5 * 1024 * 1024) throw new Error("The workbook must be 5 MB or smaller.");
      const content = await fileBase64(file);
      const preview = await request("/api/pricing/import", {
        method: "POST", body: JSON.stringify({ filename: file.name, content_base64: content, configuration: JSON.parse(draft) }),
      });
      if (state.draft !== sourceDraft || draft !== JSON.stringify(state.draft) || pricingInputProblem()) throw new Error("Pricing changed while the workbook was being read. Import it again to compare against your latest edits.");
      const counts = (kind, label) => {
        const count = preview.summary?.[kind] || {};
        return `${label}: ${count.added || 0} added, ${count.removed || 0} removed, ${count.updated || 0} updated.`;
      };
      const saveAction = $("save-pricing").getAttribute("aria-label") || "Save pricing";
      const detail = `${file.name}\n${counts("inventory", "Inventory")}\n${counts("rates", "Rates and choices")}\nThis replaces the entire draft library. Deleted workbook rows will be removed. The changes take effect only after you click ${saveAction}.`;
      const accepted = await confirmReplace(uiCopy("Review imported pricing"), detail, uiCopy("Apply to draft"));
      if (!accepted) { message(uiCopy("Import cancelled. Your pricing draft was kept.")); return; }
      if (state.draft !== sourceDraft || draft !== JSON.stringify(state.draft) || pricingInputProblem()) throw new Error("Pricing changed during import review. Import again to keep your latest edits safe.");
      state.draft = clone(preview.configuration);
      refreshPricingCatalog(); renderPricing();
      message(uiCopy("Imported pricing is ready to review. Click {0} to apply the new products, dropdown choices and rates.", [window.CeasefireI18n.term(saveAction)]));
    } catch (error) { message(uiCopy("Pricing was not imported. {0}", [error.message]), true); }
    finally { button.disabled = false; button.removeAttribute("aria-busy"); window.CeasefireI18n.attr(button, "aria-label", "Import Excel"); }
  }

  async function bootstrap() {
    const endActivity = window.CeasefireActivity?.begin();
    try {
    try {
      const data = await request("/api/bootstrap");
      state.takeoffsEnabled = data.features?.takeoffs !== false;
      state.currentFields = clone(data.fields || []);
      state.fields = clone(state.currentFields);
      state.baseline = data.baseline || { inventory: [], rate_groups: {} };
      state.configuration = data.configuration || { inventory: {}, rates: {} };
      state.pricingUsage = clone(data.pricing_usage || state.pricingUsage);
      state.draft = clone(state.configuration);
      state.libraryDraft = state.draft;
      if (Array.isArray(data.workflows) && data.workflows.length) {
        state.defaultWorkflow = data.workflows[0];
      }
      refreshPricingCatalog();
      $("loading-state").hidden = true;
      await newQuote();
      $("header-project-actions").hidden = false;
      showView("home");
      state.initialized = true;
      window.ClassifireBoot?.ready();
    } catch (error) { window.CeasefireI18n.text($("loading-state"), "The estimator could not be loaded. Reload after the local server is available."); message(error.message, true); window.ClassifireBoot?.failed(); }
    } finally { endActivity?.(); }
  }

  function reportPayload() {
    const penetration = window.CeasefirePenetrations?.quoteSnapshot?.();
    return {...projectEstimate(), ...(penetration ? {penetration} : {}), ...(state.quote ? {source_quote_id:state.quote.id} : {})};
  }

  function projectEstimate(snapshot = true) {
    updateQuoteTitle();
    return {
      title: $("quote-title").value.trim(),
      ...quoteDetails(),
      inputs: snapshot ? clone(state.inputs) : state.inputs,
      work_items: snapshot ? clone(state.workItems) : state.workItems,
      configuration: snapshot ? clone(state.quoteConfiguration || state.configuration) : state.quoteConfiguration || state.configuration,
      workflow: state.workflow,
      measurements: $("measurements").value,
    };
  }

  const estimateWorkspaceKeys = ["estimate", "calculators", "penetration", "takeoffs", "takeoffs_session_id", "library_drafts"];

  function estimateWorkspaceRequest(workspace) {
    const result = {};
    for (const key of estimateWorkspaceKeys) if (workspace[key] !== undefined) result[key] = workspace[key];
    if (workspace.estimate) {
      result.estimate = Object.fromEntries(["title", "workflow", "measurements", "inputs", "configuration", ...Object.keys(projectDetailControls), "work_items"].filter(key => workspace.estimate[key] !== undefined).map(key => [key, workspace.estimate[key]]));
    }
    if (result.penetration) result.penetration = {draft:result.penetration.draft, ...(result.penetration.composer ? {composer:result.penetration.composer} : {}), library_tracking_version:1};
    if (result.calculators) result.calculators = Object.fromEntries(Object.entries(result.calculators).map(([id, value]) => [id, {inputs: value.inputs, ...(value.schedule_rows ? {schedule_rows: value.schedule_rows} : {})}]));
    return clone(result);
  }

  function collectionFromProject(project, captured = []) {
    const entries = project.estimates || [{id:"estimate-1", name:"Estimate 1", workspace:project}];
    return entries.map(entry => {
      const previous = captured.find(item => item.id === entry.id);
      const workspace = {...entry.workspace};
      if (!workspace.takeoffs_session_id && previous?.workspace.takeoffs_session_id) workspace.takeoffs_session_id = previous.workspace.takeoffs_session_id;
      return {id:entry.id, name:entry.name, workspace};
    });
  }

  function estimateCollectionWith(workspace) {
    return {active_estimate_id:state.activeEstimateId, estimates:state.projectEstimates.map(entry => ({id:entry.id, name:entry.name,
      workspace:estimateWorkspaceRequest(entry.id === state.activeEstimateId ? workspace : entry.workspace)}))};
  }

  function resetEstimateCollection() {
    for (const entry of state.projectEstimates) void window.CeasefireTakeoffs?.discardPreparedSession?.(entry.workspace?.takeoffs_session_id);
    state.projectEstimates = [{id:"estimate-1", name:"Estimate 1"}]; state.activeEstimateId = "estimate-1"; state.estimatesDirty = false;
  }

  let editingEstimateName = null;

  function renderEstimateControls() {
    const select = $("project-estimate-select");
    if (!select) return;
    const current = state.projectEstimates.find(entry => entry.id === state.activeEstimateId);
    if (editingEstimateName !== current) {
      editingEstimateName = null;
      $("project-estimate-current-name").value = current?.name || "";
    }
    select.replaceChildren(...state.projectEstimates.map(entry => {const option = node("option", "", entry.name); option.value = entry.id; return option;}));
    select.value = state.activeEstimateId;
    for (const id of ["project-estimate-current-name", "project-estimate-select", "project-estimate-new"]) $(id).disabled = state.projectBusy;
  }

  async function captureCurrentEstimate({ readOnly = false, commercial = false } = {}) {
    document.activeElement?.blur?.();
    if (inputProblem()) throw new Error(inputProblem());
    const context = state.quoteContext, target = state.projectFile;
    const pricing = readOnly ? undefined : await previewSavePricing(), pricingRevision = savePricingStamp();
    const [calculators, penetration] = await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations?.completeProjectSnapshot()]);
    const libraryDrafts = await window.CeasefireLibraryEditor?.completeProjectSnapshot?.();
    const takeoffs = await window.CeasefireTakeoffs?.completeProjectSnapshot();
    if (context !== state.quoteContext || target !== state.projectFile || pricingRevision !== savePricingStamp() || inputProblem()) throw new Error("The estimate changed while preparing it. Try again.");
    if (JSON.stringify(calculators) !== JSON.stringify(window.CeasefireCalculators.projectSnapshot()) || JSON.stringify(penetration) !== JSON.stringify(window.CeasefirePenetrations?.projectSnapshot()) || JSON.stringify(libraryDrafts) !== JSON.stringify(window.CeasefireLibraryEditor?.projectSnapshot?.()) || JSON.stringify(takeoffs) !== JSON.stringify(window.CeasefireTakeoffs?.projectSnapshot())) throw new Error("An estimate workspace changed while preparing it. Try again.");
    const workspace = {estimate:projectEstimate(), calculators, ...(penetration ? {penetration} : {}), ...(libraryDrafts ? {library_drafts:libraryDrafts} : {}), ...(takeoffs ? {takeoffs, takeoffs_session_id:window.CeasefireTakeoffs.sessionId()} : {})};
    if (pricing) workspace.estimate.configuration = clone(pricing.configuration);
    const stamp = projectStamp();
    // Commercial linking sends this same captured workspace to /commercial/derive,
    // which performs canonical validation. Full Save/Issue keeps preparation here.
    const prepared = commercial ? {} : await request("/api/project/estimate/prepare", {method:"POST", body:JSON.stringify(workspace)});
    if (stamp !== projectStamp()) throw new Error("The estimate changed during validation. Try again.");
    return {...prepared, ...workspace};
  }

  async function applyEstimateWorkspace(workspace) {
    const stamp = projectStamp();
    const [calculators, penetration, takeoffs, libraryDrafts] = await Promise.all([
      window.CeasefireCalculators.prepareProject(workspace.calculators), window.CeasefirePenetrations?.prepareProject(workspace.penetration, workspace.estimate.configuration),
      window.CeasefireTakeoffs?.prepareProject(workspace.takeoffs, workspace.takeoffs_session_id), window.CeasefireLibraryEditor?.prepareProject?.(workspace.library_drafts)]);
    if (stamp !== projectStamp()) throw new Error("The estimate changed while switching. Try again.");
    window.CeasefireCalculators.applyProject(calculators);
    window.CeasefireCalculators.markProjectSaved(workspace.calculators);
    if (penetration) window.CeasefirePenetrations.applyProject(penetration);
    if (takeoffs) window.CeasefireTakeoffs.applyProject(takeoffs, {preservePrevious:true});
    if (libraryDrafts) window.CeasefireLibraryEditor.applyProject(libraryDrafts);
    const estimate = workspace.estimate;
    ++state.quoteContext; ++state.quoteLoadRevision;
    state.inputErrors.clear(); state.inputDrafts.clear(); state.workItemErrors.clear(); state.workItemDrafts.clear();
    state.quote = null; state.quoteConfiguration = clone(estimate.configuration); state.fields = clone(workspace.fields || state.currentFields); state.inputs = clone(estimate.inputs);
    state.workItems = clone(estimate.work_items || []); state.nextWorkItem = state.workItems.length + 1;
    state.legacyTitle = [estimate.project_no, estimate.client, estimate.site_address].some(Boolean) ? "" : estimate.title || "";
    applyQuoteDetails(estimate);
    state.workflow = estimate.workflow; $("measurements").value = estimate.measurements || "";
    resetProjectPricing("project"); updateQuoteTitle(); renderInputs(); updateDirty(false); scheduleCalculation();
    window.CeasefirePenetrations?.pricingChanged();
  }

  async function selectEstimate(identifier) {
    if (identifier === state.activeEstimateId || state.projectBusy || coverReplacementPending()) return;
    const selected = state.projectEstimates.find(entry => entry.id === identifier);
    if (!selected?.workspace) return;
    projectBusy(true);
    try {
      const current = await captureCurrentEstimate();
      await applyEstimateWorkspace(selected.workspace);
      state.projectEstimates.find(entry => entry.id === state.activeEstimateId).workspace = current;
      state.activeEstimateId = identifier; state.estimatesDirty = true;
      message(uiCopy("Estimate selected. Save the project to keep all estimate changes."));
    } catch (error) { message(error.message, true); }
    finally { projectBusy(false); }
  }

  async function estimateName(title, current) {
    const dialog = $("project-estimate-dialog");
    $("project-estimate-dialog-title").textContent = title; $("project-estimate-name").value = current;
    dialog.returnValue = "";
    const result = new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "save" ? $("project-estimate-name").value.trim() : null), {once:true}));
    dialog.showModal(); $("project-estimate-name").focus(); return result;
  }

  async function addProjectEstimate() {
    if (state.projectBusy || coverReplacementPending()) return;
    if (state.projectEstimates.length >= 50) {message("A project supports up to 50 estimates.", true); return;}
    projectBusy(true);
    try {
      const stamp = projectStamp(), name = await estimateName("New estimate", `Estimate ${state.projectEstimates.length + 1}`);
      if (!name || stamp !== projectStamp()) return;
      const current = await captureCurrentEstimate();
      const captured = projectStamp();
      const defaults = await window.CeasefireCalculators.prepareDefaults();
      const workspace = {estimate:{...current.estimate, measurements:"", work_items:[], configuration:clone(state.configuration),
        inputs:Object.fromEntries(state.currentFields.map(field => [field.cell, field.cell === "B12" ? "" : field.default ?? ""]))},
        calculators:Object.fromEntries(defaults.entries.map(([id, entry]) => [id, {inputs:entry.inputs, ...(entry.scheduleRows ? {schedule_rows:entry.scheduleRows} : {})}]))};
      const prepared = await request("/api/project/estimate/prepare", {method:"POST", body:JSON.stringify(workspace)});
      if (captured !== projectStamp()) throw new Error("The estimate changed while preparing a new estimate. Try again.");
      await applyEstimateWorkspace(prepared);
      state.projectEstimates.find(entry => entry.id === state.activeEstimateId).workspace = current;
      const identifier = `estimate-${crypto.randomUUID().replaceAll("-", "")}`;
      state.projectEstimates.push({id:identifier, name, workspace:prepared}); state.activeEstimateId = identifier; state.estimatesDirty = true;
      message(uiCopy("Estimate added. Save the project to keep it."));
    } catch (error) {message(error.message, true);}
    finally {projectBusy(false);}
  }

  function finishEstimateName() {
    const entry = editingEstimateName;
    editingEstimateName = null;
    if (!entry || !state.projectEstimates.includes(entry) || entry.id !== state.activeEstimateId) return;
    const input = $("project-estimate-current-name");
    const name = input.value.trim();
    if (!name || [...name].length > 150) {
      message(uiCopy("Give every estimate a name between 1 and 150 characters."), true);
    } else if (name !== entry.name) {
      entry.name = name;
      state.estimatesDirty = true;
    }
    updateProjectStatus();
  }

  window.CeasefireEstimates = {list:() => state.projectEstimates.map(({id,name}) => ({id,name})), activeId:() => state.activeEstimateId, select:selectEstimate,
    async capture(options) {if (state.projectBusy) throw new Error("Finish the current project operation first."); return estimateCollectionWith(await captureCurrentEstimate(options));}};

  function projectStampFields(includeCommercial = true) {
    return { passiveRegister: window.ClassifirePassiveRegister?.revision(), estimates: state.projectEstimates, active_estimate_id: state.activeEstimateId, commercial: includeCommercial ? window.CeasefireCommercial?.projectFingerprint?.() : undefined, swms: window.CeasefireSWMS?.projectFingerprint?.(), project_status: state.projectStatus, estimate: projectEstimate(false), quoteContext: state.quoteContext,
      project_follow_up: projectFollowUp, quoteLoadRevision: state.quoteLoadRevision, inputRevision: state.inputRevision,
      errors: [...state.inputErrors], inputDrafts: [...state.inputDrafts],
      pricing: state.pricingScope === "project" ? state.draft : state.projectPricingDraft,
      pricingPending: (state.pricingScope === "project" ? state.draft : state.projectPricingDraft) && [...pricingPendingFields(state.pricingScope === "project" ? state.draft : state.projectPricingDraft)],
      calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations?.projectFingerprint(), takeoffs: window.CeasefireTakeoffs?.projectFingerprint(), libraryDrafts: window.CeasefireLibraryEditor?.projectFingerprint?.(), certifications: window.CeasefireCertification?.projectFingerprint?.(), documentation:window.CeasefireDocumentation?.projectFingerprint?.() };
  }
  function projectStamp() { return JSON.stringify(projectStampFields()); }

  function commercialDetailsGuard() {
    // Exclude only the commercial editor being discarded. Keep every other
    // Project workspace, calculator, pricing and input revision in this guard.
    return JSON.stringify(projectStampFields(false));
  }

  // Cover defaults remain global Settings. Their independent stamp protects
  // replacement races; the main Save persists their drafts after the project
  // file succeeds, without embedding cover defaults in that project file.
  function projectReplacementStamp() {
    return JSON.stringify({project:projectStampFields(),coverSheets:window.CeasefireCoverSheets?.fingerprint?.(),projectPane:window.CeasefireProjectPane?.fingerprint?.()});
  }
  function coverReplacementPending(skipProjectPane = false) {
    if (window.ClassifirePassiveRegister?.busy()) { message(uiCopy("Finish adding photos before continuing."), true); return true; }
    if (window.ClassifireContacts?.hasPendingOperation?.()) { message(uiCopy(window.ClassifireContacts.pendingMessage?.() || "Finish the current Company action first."), true); return true; }
    if (!skipProjectPane && window.CeasefireProjectPane?.hasPendingOperation?.()) { message("Finish the current project details action first.", true); return true; }
    if (window.CeasefireSWMS?.hasPendingOperation?.()) { message("Finish the current SWMS edit first.", true); return true; }
    if (window.CeasefireCommercial?.hasPendingOperation?.()) { message("Finish the current commercial document edit first.", true); return true; }
    if (window.CeasefireDownloads?.hasPendingOperation?.()) {
      message(uiCopy("Finish the download and its project save before replacing a project."), true);
      return true;
    }
    if (window.CeasefireDocumentation?.hasPendingOperation?.()) {
      message(uiCopy("Finish the current document download before replacing a project."), true);
      return true;
    }
    if (window.CeasefireCertification?.hasPendingOperation?.()) {
      message(uiCopy("Finish or retry the current certification operation before replacing a project."), true);
      return true;
    }
    if (!window.CeasefireCoverSheets?.hasPendingOperation?.()) return false;
    message(uiCopy("Finish or retry the current cover-sheet operation before replacing a project."),true);
    return true;
  }

  function projectBusy(value, activeId = null) {
    if (value) finishEstimateName();
    state.projectBusy = value;
    for (const id of ["save-current-project", "load-project", "link-project-folder", "new-quote", "use-current-pricing", "project-estimate-current-name", "project-estimate-select", "project-estimate-new"]) {
      $(id).disabled = value;
      $(id).setAttribute("aria-busy", String(value && id === activeId));
    }
    $("project-attachment-zone").disabled = value;
    $("project-attachment-zone").setAttribute("aria-busy", String(value && activeId === "project-attachment-zone"));
    $("project-attachment-input").disabled = value;
    updateProjectStatus();
  }

  async function saveProject({ automatic = false, downloadTarget = null } = {}) {
    try { await window.CeasefireProjectPane?.beforeProjectSave?.(); }
    catch (error) { if (automatic) throw error; message(error.message, true); return; }
    if (state.projectBusy || window.CeasefireDownloads?.hasInFlight?.()) {
      if (automatic) throw new Error("Finish the current file operation before saving the project.");
      message(uiCopy("Finish the current file operation before saving the project."),true);
      return;
    }
    if (window.CeasefireDocumentation?.hasPendingOperation?.()) {
      if (automatic) throw new Error("Finish the current document download before saving the project.");
      message(uiCopy("Finish the current document download before saving the project."),true); return;
    }
    if (automatic && !isCurrentDownloadTarget(downloadTarget)) throw new Error("The project changed after the download. Its file was not overwritten.");
    const target = state.projectFile, context = state.quoteContext;
    const saveAs = !target?.save_token;
    let projectWritten = false;
    projectBusy(true, "save-current-project");
    try {
      document.activeElement?.blur?.();
      if (inputProblem()) throw new Error(inputProblem());
      // Validate the project pricing draft without applying it yet. Cancelling
      // Save As or a failed write must retain the exact current editing state.
      const pricing = await previewSavePricing();
      if (inputProblem()) throw new Error(inputProblem());
      const pricingStamp = savePricingStamp;
      const preparedPricing = pricingStamp();
      // Validate the calculator drafts before Takeoffs can open a physical-edit
      // review. A failed calculator must not leave an unrelated review running
      // after this Save has already stopped.
      const [calculators, penetration] = await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations?.completeProjectSnapshot()]);
      if (window.CeasefirePenetrations?.inputProblem()) throw new Error(window.CeasefirePenetrations.inputProblem());
      if (context !== state.quoteContext || target !== state.projectFile || inputProblem() || preparedPricing !== pricingStamp()) throw new Error(inputProblem() || "The project changed while preparing the file. Save again when ready.");
      if (JSON.stringify(calculators) !== JSON.stringify(window.CeasefireCalculators.projectSnapshot()) || penetration && JSON.stringify(penetration) !== JSON.stringify(window.CeasefirePenetrations.projectSnapshot())) throw new Error("The calculator drafts changed while preparing the file. Save again when ready.");
      const libraryDrafts = await window.CeasefireLibraryEditor?.completeProjectSnapshot?.(), libraryStamp = window.CeasefireLibraryEditor?.projectFingerprint?.();
      const certifications = await window.CeasefireCertification?.completeProjectSnapshot?.(), certificationStamp = window.CeasefireCertification?.projectFingerprint?.();
      const documentation = await window.CeasefireDocumentation?.completeProjectSnapshot?.(), documentationStamp = window.CeasefireDocumentation?.projectFingerprint?.();
      const takeoffs = await window.CeasefireTakeoffs?.completeProjectSnapshot();
      if (window.CeasefirePenetrations?.inputProblem()) throw new Error(window.CeasefirePenetrations.inputProblem());
      if (context !== state.quoteContext || target !== state.projectFile || inputProblem() || preparedPricing !== pricingStamp()) throw new Error(inputProblem() || "The project changed while preparing the file. Save again when ready.");
      if (JSON.stringify(calculators) !== JSON.stringify(window.CeasefireCalculators.projectSnapshot()) || penetration && JSON.stringify(penetration) !== JSON.stringify(window.CeasefirePenetrations.projectSnapshot())) throw new Error("The calculator drafts changed while preparing the file. Save again when ready.");
      if (JSON.stringify(takeoffs) !== JSON.stringify(window.CeasefireTakeoffs?.projectSnapshot())) throw new Error("Takeoffs changed while preparing the file. Save again when ready.");
      if (libraryStamp !== window.CeasefireLibraryEditor?.projectFingerprint?.()) throw new Error("Project library drafts changed while preparing the file. Save again when ready.");
      if (certificationStamp !== window.CeasefireCertification?.projectFingerprint?.()) throw new Error("Project certificates changed while preparing the file. Save again when ready.");
      if (documentationStamp !== window.CeasefireDocumentation?.projectFingerprint?.()) throw new Error("Project documents changed while preparing the file. Save again when ready.");
      const payload = { project_status: state.projectStatus, estimate: projectEstimate(), calculators, ...(penetration ? { penetration } : {}), ...(libraryDrafts ? { library_drafts: libraryDrafts } : {}), ...(certifications ? { certifications } : {}), ...(documentation ? {documentation} : {}), ...(takeoffs ? { takeoffs, takeoffs_session_id: window.CeasefireTakeoffs.sessionId() } : {}) };
      payload.project_follow_up = {...projectFollowUp};
      if (pricing) payload.estimate.configuration = clone(pricing.configuration);
      const beforeCommercial = projectStamp();
      const commercial = await window.CeasefireCommercial?.completeProjectSnapshot?.();
      const swms = await window.CeasefireSWMS?.completeProjectSnapshot?.();
      if (swms) payload.swms = swms;
      const registerCapture = window.ClassifirePassiveRegister?.capture();
      if (registerCapture?.value) payload.passive_fire_register = registerCapture.value;
      if (beforeCommercial !== projectStamp()) throw new Error("The project changed while preparing its commercial documents. Save again when ready.");
      if (commercial) payload.commercial_documents = commercial;
      Object.assign(payload, estimateCollectionWith(payload));
      if (!saveAs) payload.save_token = target.save_token;
      const directoryEdits = window.CeasefireProjectPane?.currentDirectoryEdits(payload.estimate) || [];
      const captured = projectStamp();
      if (saveAs) {
        if (!window.CeasefireProjectDetails?.prepareSave) throw new Error("Refresh the application before saving a new project.");
        payload.project_save_request = await window.CeasefireProjectDetails.prepareSave(context);
        if (context !== state.quoteContext || target !== state.projectFile || captured !== projectStamp() || preparedPricing !== pricingStamp()) throw new Error("The project changed while checking its previous clients and number. Save again when ready.");
      }
      const saved = await request(saveAs ? "/api/project/save-as" : "/api/project/save", { method: "POST", body: JSON.stringify(payload) });
      if (saved.cancelled) {
        if (automatic) throw new Error("The project save was cancelled.");
        message(uiCopy("Save cancelled. Your current project remains open.")); return;
      }
      projectWritten = true;
      const changed = captured !== projectStamp() || preparedPricing !== pricingStamp();
      if (context === state.quoteContext) {
        const savedStage = saved.file.project_status ?? saved.project.project_status ?? payload.project_status;
        state.projectFile = {...saved.file, project_status:savedStage};
        savedProjectFollowUp = followUpFields(saved.project.project_follow_up ?? payload.project_follow_up);
        projectFollowUp = projectFollowUp.actions === payload.project_follow_up.actions ? savedProjectFollowUp : {...savedProjectFollowUp, actions:projectFollowUp.actions};
        if (state.projectStatus === payload.project_status) state.projectStatus = savedStage;
        if (!changed) {
          state.projectEstimates = collectionFromProject(saved.project, payload.estimates);
          state.estimatesDirty = false;
        }
        // Identity is assigned by the successful save even if other inputs were
        // edited while its file chooser was open. Retain those later edits.
        const assigned = new Map((saved.project.estimates || []).map(entry => [entry.id, entry.workspace.estimate.project_no]));
        for (const entry of state.projectEstimates) {
          if (!entry.workspace?.estimate) continue;
          const estimate = entry.workspace.estimate;
          const projectNo = assigned.get(entry.id) ?? saved.project.estimate.project_no ?? "";
          if (estimate.project_no !== projectNo) {
            estimate.project_no = projectNo;
            estimate.title = [estimate.project_no, estimate.client, (estimate.site_address || "").replace(/\s+/g," ")].filter(Boolean).join("- ") || estimate.title;
          }
        }
        $("project-no").value = assigned.get(state.activeEstimateId) ?? saved.project.estimate.project_no ?? "";
        updateQuoteTitle();
        window.CeasefireProjectPane?.projectSaved?.({...saved.project.estimate,follow_up_actions:savedProjectFollowUp.actions});
        window.CeasefireProjectDetails?.saved(context);
        if (commercial) window.CeasefireCommercial?.markProjectSaved?.(saved.project.commercial_documents, commercial);
        window.CeasefireCommercial?.projectNumberAssigned?.(quoteDetails());
        window.ClassifirePassiveRegister?.markSaved(registerCapture);
        if (swms) window.CeasefireSWMS?.markProjectSaved?.(saved.project.swms, swms);
        window.CeasefireDownloads?.projectSaved?.({ project_context: context, project_path: saved.file.path });
        window.CeasefireCalculators.markProjectSaved(saved.project.calculators, calculators);
        if (penetration) window.CeasefirePenetrations.markProjectSaved(saved.project.penetration, penetration);
        if (takeoffs) window.CeasefireTakeoffs.markProjectSaved(saved.project.takeoffs, takeoffs);
        if (libraryDrafts) window.CeasefireLibraryEditor.markProjectSaved(saved.project.library_drafts, libraryDrafts);
        if (certifications) window.CeasefireCertification.markProjectSaved(saved.project.certifications, certifications);
        if (documentation) window.CeasefireDocumentation.markProjectSaved(saved.project.documentation, documentation);
        if (!changed) {
          state.quote = null; state.quoteConfiguration = clone(saved.project.estimate.configuration);
          state.fields = clone(saved.project.fields);
          if (pricing?.scope === "library") {
            state.libraryDraft = clone(state.configuration);
            if (state.pricingScope === "library") state.draft = state.libraryDraft;
            resetProjectPricing("project");
            if (pricing.unchosenProjectDraft) { state.projectPricingDraft = pricing.unchosenProjectDraft; state.draft = state.projectPricingDraft; refreshPricingCatalog(); renderPricing(); }
          } else resetProjectPricing();
          renderInputs(); updateDirty(false); scheduleCalculation();
          window.CeasefirePenetrations?.pricingChanged();
          $("snapshot-message").hidden = false;
          window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "This project uses the pricing saved in its file.");
        } else updateDirty();
      }
      if (!automatic) await window.CeasefireCoverSheets?.saveAll?.();
      let directoryWarning = "";
      try { await window.CeasefireProjectPane?.syncDirectory(saved.file,directoryEdits); }
      catch (error) { directoryWarning = uiCopy("Project saved. Directory details still need syncing. {0}", [error.message]); }
      const saveWarnings = [
        directoryWarning,
        pricing?.conflict ? window.CeasefireI18n.translate("The other pricing draft is still available and was not included.") : "",
        changed ? window.CeasefireI18n.translate("Later edits are not included and still need saving.") : "",
        saved.warning || "",
      ].filter(Boolean).join(" ");
      // The header's saved state is sufficient for ordinary success. Preserve
      // actionable warnings and any error already raised by a concurrent edit.
      if (saveWarnings && (!changed || $("app-message").getAttribute("role") !== "alert")) message(saveWarnings);
      return { saved: true, file: saved.file, changed };
    } catch (error) {
      if (automatic) throw error;
      message(uiCopy(projectWritten ? "The project file was saved, but cover-sheet changes still need saving. {0}" : "Project was not saved. {0}", [error.message]), true);
      return { saved: false, error: error.message };
    }
    finally { projectBusy(false); }
  }

  async function openNativeProject() {
    if (state.projectBusy || coverReplacementPending()) return;
    if (window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    projectBusy(true, "load-project");
    try {
      const captured = projectReplacementStamp();
      const project = await request("/api/project/open", { method: "POST", body: "{}" });
      if (project.cancelled) { message(uiCopy("Project load cancelled. Your current drafts were kept.")); return; }
      await reviewAndLoadProject(project, project.file, captured);
    } catch (error) { message(uiCopy("Project was not loaded. {0}", [error.message]), true); }
    finally { projectBusy(false); }
  }

  async function loadProject() {
    if (coverReplacementPending()) return;
    if (window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    const input = $("project-import-file"), file = input.files?.[0]; input.value = "";
    if (!file || state.projectBusy) return;
    projectBusy(true, "load-project");
    try {
      if (!/\.cf\.json$/i.test(file.name) || !file.size || file.size > 16 * 1024 * 1024) throw new Error("Choose a .cf.json project file up to 16 MB.");
      const captured = projectReplacementStamp();
      const content_base64 = await fileBase64(file);
      const project = await request("/api/project/import", { method: "POST", body: JSON.stringify({ filename: file.name, content_base64 }) });
      await reviewAndLoadProject(project, { name: file.name, ...(file.lastModified ? { modified_at: new Date(file.lastModified).toISOString() } : {}) }, captured);
    } catch (error) { message(uiCopy("Project was not loaded. {0}", [error.message]), true); }
    finally { projectBusy(false); }
  }

  function projectAttachmentNotice(text = uiCopy("Files save beside the current project.")) {
    uiText($("project-attachment-status"), text);
  }

  function requireSavedProjectForFiles() {
    if (state.projectFile?.save_token) return true;
    const text = 'There is no saved project. Please click "Save" and select a project folder.';
    projectAttachmentNotice(uiCopy(text)); message(uiCopy(text), true); return false;
  }

  function hasCreatedProject() {
    return Boolean(state.projectFile?.save_token && state.projectFile.project_no?.trim());
  }
  function requireCreatedProject() {
    if (hasCreatedProject()) return true;
    message(uiCopy("Create or load a project before creating documents."), true);
    return false;
  }

  async function discardNewProject(operation) {
    if (!operation?.saved && operation?.certification?.workspace_id) {
      await window.CeasefireCertification?.discardPreparedSession?.(operation.certification.workspace_id);
      operation.certification = null; operation.request = null;
    }
  }
  async function createProject(details, operation) {
    if (state.projectBusy || coverReplacementPending(true)) return {saved:false};
    if (operation.context !== state.quoteContext) throw new Error("The current project changed. Open New Project again.");
    const captured = projectReplacementStamp();
    if (operation.reviewStamp !== captured && projectHasChanges() && !await confirmReplace(uiCopy("Start a new project?"), uiCopy("The Quote, Firestopping items, {0}project library drafts, project pricing and all three specialist calculator drafts will be replaced with defaults using your saved pricing library. Shared libraries stay unchanged.", [window.CeasefireI18n.term(takeoffContents())]), uiCopy("New project"))) return {saved:false};
    if (captured !== projectReplacementStamp()) throw new Error("Your draft changed during review. Your current project was kept.");
    operation.reviewStamp = captured;
    projectBusy(true, "new-quote");
    try {
      if (!operation.request) {
        if (!operation.certification) operation.certification = await window.CeasefireCertification.prepareProject();
        const saveRequest = await window.CeasefireProjectDetails.prepareSave(operation.id);
        const configuration = clone(state.configuration);
        const {identity, followUp} = splitProjectDetails(details);
        operation.request = {project_status:"New", project_follow_up:followUp, estimate:{...identity, configuration, workflow:state.defaultWorkflow, measurements:"", work_items:[],
          inputs:Object.fromEntries(state.currentFields.map(field=>[field.cell,field.cell === "B12" ? "" : field.default ?? ""]))}, calculators:{},
          certifications:{workspace_id:operation.certification.workspace_id,draft:null}};
        operation.request.project_save_request = saveRequest;
      }
      if (captured !== projectReplacementStamp() || coverReplacementPending(true)) throw new Error("Your draft changed while preparing the new project. Your current project was kept.");
      operation.submitted = true;
      const saved = await request("/api/project/save-as", {method:"POST",body:JSON.stringify(operation.request)});
      operation.uncertain = false;
      if (saved.cancelled) return {saved:false,cancelled:true};
      operation.saved = true;
      const project = {...saved.project,certification_workspace_id:operation.certification.workspace_id};
      const adopted = await reviewAndLoadProject(project,saved.file,captured,{confirmedReplacement:true,landingView:"quotes"});
      window.CeasefireProjectDetails.saved(operation.id);
      try { await window.CeasefireProjectPane?.syncDirectory(saved.file,window.CeasefireProjectPane.directoryEdits(details,{})); }
      catch (error) { message(uiCopy("Project saved. Directory details still need syncing. {0}", [error.message]),true); }
      if (!adopted) message(uiCopy("The new project was saved. Your current draft was kept; open the saved project from Projects."),true);
      return {saved:true,adopted:!!adopted,file:saved.file};
    } catch (error) {
      if (operation.saved) {
        message(uiCopy("The new project was saved. Your current draft was kept; open the saved project from Projects."),true);
        return {saved:true,adopted:false};
      }
      operation.uncertain = operation.submitted && (!error.status || error.status >= 500);
      throw error;
    } finally { projectBusy(false); }
  }

  async function uploadProjectFiles(selectedFiles) {
    const files = Array.from(selectedFiles || []);
    if (!files.length || state.projectBusy || !requireSavedProjectForFiles()) return;
    if (files.length > 50) { message(uiCopy("Choose no more than 50 project files at once."), true); return; }
    const target = state.projectFile, saved = [];
    projectBusy(true, "project-attachment-zone");
    try {
      for (const [index, file] of files.entries()) {
        if (!file?.name || file.size > 16 * 1024 * 1024) throw new Error("Each project file must have a filename and be 16 MB or smaller.");
        projectAttachmentNotice(uiCopy("Saving {0} of {1}: {2}", [index + 1, files.length, file.name]));
        const content_base64 = await fileBase64(file);
        if (state.projectFile !== target) throw new Error("The saved project changed while the files were being read. Choose them again.");
        const result = await request("/api/project/attachment", { method: "POST", body: JSON.stringify({ project_token: target.save_token, filename: file.name, content_base64 }) });
        saved.push(result.filename);
      }
      const detail = `${saved.length} ${saved.length === 1 ? "file" : "files"} saved to the project folder: ${saved.join(", ")}`;
      projectAttachmentNotice(detail); message(detail);
    } catch (error) {
      const prefix = saved.length ? `${saved.length} ${saved.length === 1 ? "file was" : "files were"} saved before the upload stopped. ` : "Project files were not saved. ";
      projectAttachmentNotice(`${prefix}${error.message}`); message(`${prefix}${error.message}`, true);
    } finally {
      $("project-attachment-input").value = ""; projectBusy(false);
    }
  }

  function chooseProjectFiles() {
    if (!state.projectBusy && requireSavedProjectForFiles()) $("project-attachment-input").click();
  }

  async function reviewAndLoadProject(project, file, captured, {convertedLead = false,confirmedReplacement = false,linkedProject = false,landingView = "estimate"} = {}) {
    let takeoffsAdopted = false, certificationAdopted = false, preparedCertification = null;
    try {
      if (coverReplacementPending(confirmedReplacement)) return;
      if (!state.takeoffsEnabled && (project.takeoffs || project.takeoffs_session_id)) throw new Error("This project contains TAKEOFFS data. Open it in the full edition; this edition cannot remove or overwrite that evidence.");
      const [prepared, penetration, takeoffs, libraryDrafts, certification] = await Promise.all([window.CeasefireCalculators.prepareProject(project.calculators), window.CeasefirePenetrations?.prepareProject(project.penetration, project.estimate.configuration), window.CeasefireTakeoffs?.prepareProject(project.takeoffs, project.takeoffs_session_id), window.CeasefireLibraryEditor?.prepareProject?.(project.library_drafts), window.CeasefireCertification?.prepareProject?.(project.certifications, project.certification_workspace_id)]);
      preparedCertification = certification;
      const documentation = await window.CeasefireDocumentation?.prepareProject?.(project.documentation, certification?.workspace_id || project.certification_workspace_id);
      const commercial = await window.CeasefireCommercial?.prepareProject?.(project.commercial_documents, certification?.workspace_id || project.certification_workspace_id);
      const swms = await window.CeasefireSWMS?.prepareProject?.(project.swms, certification?.workspace_id || project.certification_workspace_id);
      if (coverReplacementPending(confirmedReplacement)) return;
      if (captured !== projectReplacementStamp()) throw new Error("Your draft changed while reading the file. Load it again when ready.");
      const detail = project.project_details || {};
      const accepted = confirmedReplacement || convertedLead && !projectHasChanges() || await confirmReplace(uiCopy("Load this project?"), uiCopy("{0}\nProject No.: {1}\nClient: {2}\nSite Address: {3}", [file.name, detail.project_no || "Not recorded", detail.client || "Not recorded", detail.site_address || "Not recorded"]), uiCopy("Load Project"));
      if (!accepted) { message(uiCopy("Project load cancelled. Your current drafts were kept.")); return; }
      if (coverReplacementPending(confirmedReplacement)) return;
      if (captured !== projectReplacementStamp()) throw new Error("Your draft changed during review. Load the file again to keep your latest edits safe.");
      const estimate = project.estimate;
      // All validation and definition loading finish before either workspace changes.
      const inputs = clone(estimate.inputs), configuration = clone(estimate.configuration), fields = clone(project.fields);
      if (linkedProject) window.CeasefireProjectPane?.closeAfterReplacement();
      window.CeasefireCalculators.applyProject(prepared);
      window.CeasefireCalculators.markProjectSaved(project.calculators);
      if (penetration) window.CeasefirePenetrations.applyProject(penetration);
      if (takeoffs) window.CeasefireTakeoffs.applyProject(takeoffs);
      if (libraryDrafts) window.CeasefireLibraryEditor.applyProject(libraryDrafts);
      takeoffsAdopted = true;
      ++state.quoteContext; ++state.quoteLoadRevision;
      state.inputErrors.clear(); state.inputDrafts.clear(); state.workItemErrors.clear(); state.workItemDrafts.clear();
      state.quote = null; state.quoteConfiguration = configuration; state.fields = fields; state.inputs = inputs;
      state.workItems = clone(estimate.work_items || []); state.nextWorkItem = state.workItems.length + 1;
      resetEstimateCollection();
      state.projectEstimates = collectionFromProject(project);
      state.activeEstimateId = project.active_estimate_id || "estimate-1";
      state.estimatesDirty = !!file.active_estimate_id && file.active_estimate_id !== state.activeEstimateId;
      state.projectStatus = project.project_status || "New";
      savedProjectFollowUp = projectFollowUp = followUpFields(project.project_follow_up);
      state.projectFile = { ...file, title: estimate.title, project_status: state.projectStatus }; resetProjectPricing("project");
      state.legacyTitle = [estimate.project_no, estimate.client, estimate.site_address].some(Boolean) ? "" : estimate.title || "";
      applyQuoteDetails(estimate);
      if (certification) { window.CeasefireCertification.applyProject(certification); certificationAdopted = true; }
      window.CeasefireDocumentation?.applyProject?.(documentation);
      window.CeasefireCommercial?.applyProject?.(commercial);
      window.CeasefireSWMS?.applyProject?.(swms);
      window.ClassifirePassiveRegister?.applyProject(project.passive_fire_register);
      state.workflow = estimate.workflow; $("measurements").value = estimate.measurements || "";
      updateQuoteTitle(); renderInputs(); updateDirty(false);
      $("snapshot-message").hidden = false; window.CeasefireI18n.text($("snapshot-message").querySelector("span"), "This project uses the pricing snapshot from its file.");
      selectEstimator("estimate"); showView(landingView); scheduleCalculation();
      window.CeasefirePenetrations?.pricingChanged();
      message(file.save_token ? uiCopy("Project loaded with the Quote, Firestopping items, {0}original pricing and all three specialist calculators. Save updates this project file.", [window.CeasefireI18n.term(takeoffContents())]) : uiCopy("Project imported with the Quote, Firestopping items, {0}original pricing and all three specialist calculators. Use Save to choose its project file.", [window.CeasefireI18n.term(takeoffContents())]));
      return true;
    } finally {
      if (!takeoffsAdopted) {
        await window.CeasefireTakeoffs?.discardPreparedSession?.(project.takeoffs_session_id);
        for (const entry of project.estimates || []) await window.CeasefireTakeoffs?.discardPreparedSession?.(entry.workspace.takeoffs_session_id);
      }
      if (!certificationAdopted) await window.CeasefireCertification?.discardPreparedSession?.(preparedCertification?.workspace_id || project.certification_workspace_id);
    }
  }

  function positionProjectCardMenu(menu) {
    if (!menu.open) return;
    const panel = menu.querySelector(".project-menu-options"), toggle = menu.querySelector("summary");
    const bounds = toggle.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= innerHeight || bounds.right <= 0 || bounds.left >= innerWidth) { menu.open = false; return; }
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, bounds.right - panel.offsetWidth))}px`;
    panel.style.top = `${bounds.bottom + panel.offsetHeight + 12 <= innerHeight ? bounds.bottom + 6 : Math.max(8, bounds.top - panel.offsetHeight - 6)}px`;
  }
  const positionProjectCardMenus = () => document.querySelectorAll("#project-list .project-card-menu[open]").forEach(positionProjectCardMenu);
  window.addEventListener("resize", positionProjectCardMenus);
  window.addEventListener("scroll", event => { if (!event.target.closest?.(".project-menu-options")) positionProjectCardMenus(); }, true);

  function applyProjectColumnVisibility() {
    for (const column of $("project-list").querySelectorAll(".project-kanban-column")) {
      column.hidden = hiddenProjectStages.has(column.dataset.status);
    }
    window.ClassifireDocumentBoard.refreshFollowUps();
  }

  function renderProjectList() {
    const canEdit = () => !window.ClassifireAccess || window.ClassifireAccess.can("edit");
    const canMove = () => !state.projectBusy && canEdit();
    window.ClassifireDocumentBoard.render($("project-list"), {
      items: state.projectCards,
      stages: projectStatuses,
      emptyLabel: "No projects",
      stageOf: file => file.project_status || "New",
      locked: () => !canMove(),
      move: changeProjectStage,
      onError: error => message(error.message, true),
      cardFor: file => {
        const row = node("article", "project-kanban-card project-list-row");
        row.dataset.projectId = file.id;
        const title = node("button", "project-title-button", file.title || file.name);
        title.type = "button";
        window.CeasefireI18n.attr(title, "aria-label", "Project details for {0}", [file.title || file.name]);
        title.addEventListener("click", () => window.CeasefireProjectPane?.open(file));
        const heading = node("div", "project-row-heading");
        heading.append(title);
        window.ClassifireDocumentBoard.addFollowUpMarker(heading, file.follow_up_date, event =>
          window.ClassifireFollowUpActions.openDialog({
            trigger:event.currentTarget, recordName:file.title || file.name, readOnly:!canEdit(),
            load:async () => {
              const saved = await request("/api/projects/details", {method:"POST",body:JSON.stringify({id:file.id})});
              return {actions:saved.project_follow_up.actions, revision:saved.revision};
            },
            save:(actions, loaded, request_id) => {
              if (state.projectFile?.path === file.path && (state.projectBusy ||
                  JSON.stringify(projectFollowUp.actions) !== JSON.stringify(savedProjectFollowUp.actions))) {
                throw new Error("Save your Project Details edits before changing its follow-up actions.");
              }
              return request("/api/projects/follow-up", {method:"POST",body:JSON.stringify({id:file.id, revision:loaded.revision, actions, request_id})});
            },
            onSaved:async (result, loaded) => {
              if (state.projectFile?.path === result.file.path && state.projectFile.revision === loaded.revision) {
                const clean = JSON.stringify(projectFollowUp.actions) === JSON.stringify(savedProjectFollowUp.actions);
                state.projectFile = result.file;
                savedProjectFollowUp = followUpFields(result.project_follow_up);
                projectFollowUp = clean ? savedProjectFollowUp : {...savedProjectFollowUp, actions:projectFollowUp.actions};
                updateProjectStatus();
              }
              await loadProjects();
            },
            restoreFocus:() => {
              const card = $("project-list").querySelector('[data-project-id="' + CSS.escape(file.id) + '"]');
              return card?.querySelector(".board-follow-up-due:not([hidden])") || card?.querySelector(".project-title-button");
            }
          }));
        const details = node("div", "project-row-details");
        const information = node("dl", "kanban-card-details");
        for (const [label, value] of [
          ["Project No.", file.project_no], ["Client", file.client], ["Site address", file.site_address],
          ["Next action", file.next_action], ["Follow-up due", file.follow_up_date && new Date(file.follow_up_date+"T00:00:00Z").toLocaleDateString("en-AU",{timeZone:"UTC",day:"2-digit",month:"2-digit",year:"numeric"})],
          ["Updated", new Date(file.modified_at).toLocaleString("en-AU", {year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})]
        ]) information.append(uiNode("dt", "", label), node("dd", "", value || "—"));
        details.append(heading, information);
        const estimateLabel = uiNode("label", "field project-card-estimate", "Estimate"), estimateSelect = node("select");
        estimateSelect.setAttribute("aria-label", `Estimate for ${file.title || file.name}`);
        const prompt = uiNode("option", "", "Select estimate"); prompt.value = ""; estimateSelect.append(prompt);
        for (const entry of file.estimates || [{id:"estimate-1",name:"Estimate 1"}]) {
          const option = node("option", "", entry.name); option.value = entry.id; estimateSelect.append(option);
        }
        estimateSelect.value = ""; estimateLabel.append(estimateSelect);
        const controls = node("div", "project-row-actions");
        const load = uiNode("button", "button project-load-button", "Load");
        load.type = "button";
        window.CeasefireI18n.attr(load, "aria-label", "Load {0}", [file.title || file.name]);
        load.addEventListener("click", () => openProjectFile(file, load, estimateSelect.value, estimateSelect.value ? {} : {landingView:"quotes"}));
        const menu = node("details", "project-card-menu"), toggle = node("summary", "project-card-menu-toggle");
        window.CeasefireI18n.attr(toggle, "aria-label", "Actions for {0}", [file.title || file.name]);
        const chevron = node("span", "calculator-document-chevron"); chevron.setAttribute("aria-hidden", "true");
        chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"></path></svg>';
        toggle.append(chevron);
        const actions = node("div", "project-menu-options"), needsEstimate = [];
        const statusField = uiNode("label", "field project-row-status", "Move to"), status = node("select");
        window.CeasefireI18n.attr(status, "aria-label", "Status for {0}", [file.title || file.name]);
        for (const stage of projectStatuses) {
          const option = uiNode("option", "", stage); option.value = stage; status.append(option);
        }
        status.value = file.project_status || "New";
        status.disabled = !canEdit();
        status.addEventListener("change", () => {
          const next = status.value;
          status.value = file.project_status || "New";
          menu.open = false;
          void changeProjectStage(file, next);
        });
        statusField.append(status);
        for (const [label, action, requiresEstimate] of [
          ["Open", () => window.CeasefireProjectPane?.open(file)],
          ["Load", button => openProjectFile(file, button, "", {landingView:"quotes"})],
          ["Edit", button => openProjectFile(file, button, estimateSelect.value), true],
          ["Delete", () => deleteProjectCard(file)], ["Browse files", () => openProjectBrowser(file)]
        ]) {
          const button = uiNode("button", "text-button", label); button.type = "button";
          if (requiresEstimate) { button.disabled = true; needsEstimate.push(button); }
          button.addEventListener("click", () => { if (requiresEstimate && !estimateSelect.value) return; menu.open = false; return action(button); });
          actions.append(button);
        }
        estimateSelect.addEventListener("change", () => { for (const button of needsEstimate) button.disabled = !estimateSelect.value; });
        menu.addEventListener("toggle", () => positionProjectCardMenu(menu));
        menu.addEventListener("keydown", event => { if (event.key === "Escape" && menu.open) { menu.open = false; toggle.focus(); } });
        menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget)) menu.open = false; });
        actions.append(statusField); menu.append(toggle, actions);
        heading.append(menu); controls.append(estimateLabel, load);
        row.append(details, controls);
        return row;
      }
    });
    applyProjectColumnVisibility();
  }

  async function changeProjectStage(file, status) {
    if (state.projectBusy || !projectStatuses.includes(status) || status === (file.project_status || "New")) return;
    projectBusy(true);
    try {
      const selection = file.save_token ? {save_token: file.save_token} : {id: file.id};
      const result = await request("/api/projects/status", { method: "POST", body: JSON.stringify({...selection, revision: file.revision, project_status: status}) });
      if (state.projectFile?.path === file.path && state.projectFile.revision === file.revision) {
        state.projectFile = result.file; state.projectStatus = status;
      }
      await loadProjects();
      message(uiCopy("Project moved to {0}.", [status]));
    } catch (error) { message(error.message, true); }
    finally { projectBusy(false); }
  }

  async function changeCurrentProjectStage(status = state.projectStatus) {
    if (state.projectBusy || !projectStatuses.includes(status)) return;
    if (state.projectFile?.save_token) await changeProjectStage(state.projectFile, status);
    else { state.projectStatus = status; updateProjectStatus(); }
  }

  async function deleteProjectCard(file) {
    if (state.projectBusy) return;
    const accepted = await confirmReplace(uiCopy("Delete project?"), uiCopy("Remove {0} from Projects? Its project file will be retained under a recovery filename in the same folder. Companion documents stay in place.", [file.title || file.name]), uiCopy("Delete"));
    if (!accepted || state.projectBusy) return;
    projectBusy(true);
    try {
      await request("/api/projects/delete", {method: "POST", body: JSON.stringify({id: file.id, revision: file.revision})});
      if (state.projectFile?.path === file.path) { state.projectFile = null; updateDirty(true); }
      await loadProjects(); message(uiCopy("Project deleted from Projects."));
    } catch (error) { message(error.message, true); }
    finally { projectBusy(false); }
  }


  async function loadProjects({ refresh = false, offset = state.projectsOffset } = {}) {
    clearTimeout(state.projectsTimer);
    const revision = ++state.projectsRevision;
    const list = $("project-list"); list.setAttribute("aria-busy", "true");
    const search = $("project-search").value.trim(), sort = $("project-sort").value || "modified_desc";
    const query = [];
    if (search) query.push(`search=${encodeURIComponent(search)}`);
    if (sort !== "modified_desc") query.push(`sort=${encodeURIComponent(sort)}`);
    if (refresh) query.push("refresh=1");
    try {
      const data = await request(`/api/projects${query.length ? `?${query.join("&")}` : ""}`);
      if (!data.scan_pending) {
        const pageQuery = query.filter(part => part !== "refresh=1");
        while (data.files?.length < data.matched) {
          const page = await request(`/api/projects?${[...pageQuery, `offset=${data.files.length}`].join("&")}`);
          if (revision !== state.projectsRevision) return;
          if (!page.files.length) break;
          data.files.push(...page.files);
        }
      }
      if (revision !== state.projectsRevision) return;
      if (data.folder) $("project-folder").textContent = data.folder;
      else window.CeasefireI18n.text($("project-folder"), "Link your estimates folder to list its project files and use it as the default save location.");
      state.projectsOffset = 0;
      state.projectCards = data.files || [];
      renderProjectList();
      const matched = data.matched ?? state.projectCards.length, total = data.total ?? matched;
      window.CeasefireI18n.text($("project-list-status"), "{0} matching projects · {1} found{2}", [matched, total, data.scan_pending ? ` · Scanning subfolders (${data.scanned_entries || 0} entries checked)…` : ""]);
      $("project-previous").disabled = true;
      $("project-next").disabled = true;
      if ($("project-previous").parentElement) $("project-previous").parentElement.hidden = true;
      $("project-continue").hidden = !data.scan_pending;
      if (!data.scan_pending) window.ClassifireProjectParticipants?.scanComplete?.();
      const problems = (data.errors || []).map(item => `${item.name}: ${item.error}`);
      if (data.error_count > problems.length) problems.push(`${data.error_count - problems.length} additional entries could not be listed.`);
      if (data.truncated && !data.scan_pending) problems.push("Some entries could not be listed. Refresh to try again; details are shown below.");
      $("project-file-errors").textContent = problems.join("\n"); $("project-file-errors").hidden = !problems.length;
      if (data.scan_pending && state.currentView === "quotes") state.projectsTimer = setTimeout(() => { if (revision === state.projectsRevision && state.currentView === "quotes") loadProjects(); }, 250);
    } catch (error) {
      if (revision === state.projectsRevision) {
        list.replaceChildren(node("p", "message error", error.message));
        window.CeasefireI18n.text($("project-list-status"), "Project list unavailable · use Refresh to retry");
        $("project-continue").hidden = true;
      }
    } finally { if (revision === state.projectsRevision) list.setAttribute("aria-busy", "false"); }
  }

  async function linkProjectFolder() {
    if (state.projectBusy) return;
    if (window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    projectBusy(true, "link-project-folder");
    try {
      const data = await request("/api/projects/link-folder", { method: "POST", body: "{}" });
      if (data.cancelled) { message(uiCopy("Folder selection cancelled.")); return; }
      closeProjectBrowser(); state.projectsOffset = 0;
      await loadProjects(); message(uiCopy("Estimates folder linked: {0}", [data.folder]));
    } catch (error) { message(uiCopy("Folder was not linked. {0}", [error.message]), true); }
    finally { projectBusy(false); }
  }

  async function openProjectFile(file, button, estimateId = null, options = {}) {
    if (state.projectBusy || coverReplacementPending()) return;
    if (!options.linkedProject && window.CeasefireProjectPane && !await window.CeasefireProjectPane.leave()) return;
    if (estimateId && state.projectFile?.path === file.path && state.projectEstimates.some(entry => entry.id === estimateId)) {
      await selectEstimate(estimateId);
      if (state.activeEstimateId === estimateId) { selectEstimator("estimate"); showView("estimate"); }
      return;
    }
    projectBusy(true); button.disabled = true; button.setAttribute("aria-busy", "true");
    try {
      const captured = projectReplacementStamp();
      const target = options.linkedProject ? {linked_project: {source:file.source, owner:file.owner, project_no:file.project_no}} : {id:file.id};
      const project = await request("/api/projects/load", { method: "POST", body: JSON.stringify(target) });
      if (estimateId && project.estimates) {
        const selected = project.estimates.find(entry => entry.id === estimateId);
        if (!selected) throw new Error("The selected estimate is no longer available. Refresh Projects.");
        for (const key of [...estimateWorkspaceKeys, "fields"]) delete project[key];
        for (const key of [...estimateWorkspaceKeys, "fields", "project_details"]) if (selected.workspace[key] !== undefined) project[key] = selected.workspace[key];
        project.active_estimate_id = estimateId;
      }
      return await reviewAndLoadProject(project, project.file || file, captured, options);
    } catch (error) { message(uiCopy("Project was not loaded. {0}", [error.message]), true); }
    finally { projectBusy(false); button.disabled = false; button.setAttribute("aria-busy", "false"); }
  }

  let openingLinkedProject = false;
  async function openLinkedProject(file, button) {
    if (openingLinkedProject || state.projectBusy || coverReplacementPending() || window.ClassifireProjectParticipants?.pending()) return;
    openingLinkedProject = true;
    try {
      const pane = window.CeasefireProjectPane;
      if (projectHasChanges() || pane?.hasUnsavedChanges() || window.CeasefireCoverSheets?.hasUnsavedChanges?.()) {
        const captured = projectReplacementStamp();
        const choice = await chooseReplacement(uiCopy("Save changes before opening the linked project?"),
          uiCopy("Opening {0} will replace your current project.", [button.textContent]), uiCopy("Save"), uiCopy("Cancel"), "Open without saving");
        if (choice !== "confirm" && choice !== "alternate") return;
        if (captured !== projectReplacementStamp()) throw new Error("Your draft changed during review. Load the file again to keep your latest edits safe.");
        if (choice === "confirm") {
          await pane?.savePendingDetails();
          if (projectHasChanges() || window.CeasefireCoverSheets?.hasUnsavedChanges?.()) {
            const result = await saveProject();
            if (!result?.saved || result.changed || projectHasChanges()) return;
          }
          if (pane?.hasUnsavedChanges()) return;
        }
      }
      if (await openProjectFile(file, button, null, {linkedProject:true, confirmedReplacement:true, landingView:"quotes"})) {
        await window.CeasefireProjectPane?.openCurrent();
      }
    } catch (error) { message(error.message, true); }
    finally { openingLinkedProject = false; }
  }

  function projectFileIcon(entry) {
    const icon = node("span", "project-browser-entry-symbol"); icon.setAttribute("aria-hidden", "true");
    if (entry.type === "folder") { icon.textContent = "📁"; return icon; }
    const extension = String(entry.name).split(".").pop().toLowerCase();
    const image = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tif", "tiff", "heic"].includes(extension);
    const sheet = ["xls", "xlsx", "csv", "ods"].includes(extension);
    const label = extension === "pdf" ? "PDF" : sheet ? "XLS" : ["doc", "docx", "odt"].includes(extension) ? "DOC"
      : ["zip", "7z", "rar"].includes(extension) ? "ZIP" : ["mp3", "wav", "m4a"].includes(extension) ? "AUDIO"
      : ["mp4", "mov", "avi", "webm"].includes(extension) ? "VIDEO" : ["json", "txt", "md"].includes(extension) ? extension.toUpperCase() : "FILE";
    icon.className += ` project-file-symbol${image ? " image" : extension === "pdf" ? " pdf" : sheet ? " sheet" : ""}`;
    if (image) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"></rect><circle cx="8" cy="8" r="2"></circle><path d="m3 19 6-7 4 4 3-4 5 7"></path></svg>';
    else icon.textContent = label;
    return icon;
  }

  const projectFileSize = value => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes.toLocaleString("en-AU")} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} KB`;
    return `${(bytes / 1_048_576).toLocaleString("en-AU", { maximumFractionDigits: 1 })} MB`;
  };

  function closeProjectBrowser() {
    ++state.projectBrowserRevision;
    state.projectBrowserProject = null; state.projectBrowserPath = "";
    $("project-browser").hidden = true;
    $("project-list-card").hidden = false;
    $("project-register").hidden = false;
    $("project-workspace-layout").hidden = true;
    $("project-file-errors").hidden = !$("project-file-errors").textContent;
    window.scrollTo({top:0,left:0,behavior:"instant"});
  }

  function renderProjectBreadcrumbs(project, relativePath) {
    const breadcrumbs = $("project-browser-breadcrumbs"), parts = relativePath ? relativePath.split("/") : [];
    const values = [{ label: project.title || project.name, path: "" }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join("/") }))];
    const nodes = [];
    for (const [index, value] of values.entries()) {
      if (index) nodes.push(node("span", "", "/"));
      const button = node("button", "", value.label); button.type = "button";
      if (value.path === relativePath) button.setAttribute("aria-current", "page");
      else button.addEventListener("click", () => loadProjectFiles(project, value.path));
      nodes.push(button);
    }
    breadcrumbs.replaceChildren(...nodes);
  }

  async function openProjectFolderFile(project, entry, button) {
    if (button.getAttribute("aria-busy") === "true") return;
    const revision = state.projectBrowserRevision;
    button.disabled = true; button.setAttribute("aria-busy", "true");
    try {
      await request("/api/projects/open-file", { method: "POST", body: JSON.stringify({ id: project.id, relative_path: entry.relative_path }) });
      if (revision === state.projectBrowserRevision && state.projectBrowserProject?.id === project.id) {
        window.CeasefireI18n.text($("project-browser-message"), "Opened {0} in its default application.", [entry.name]);
        $("project-browser-message").className = "message info"; $("project-browser-message").hidden = false;
      }
    } catch (error) {
      if (revision === state.projectBrowserRevision && state.projectBrowserProject?.id === project.id) {
        window.CeasefireI18n.text($("project-browser-message"), "The file was not opened. {0}", [error.message]);
        $("project-browser-message").className = "message error"; $("project-browser-message").hidden = false;
      }
    } finally { button.disabled = false; button.setAttribute("aria-busy", "false"); }
  }

  async function loadProjectFiles(project, relativePath = "") {
    const revision = ++state.projectBrowserRevision, list = $("project-browser-list");
    state.projectBrowserProject = project; state.projectBrowserPath = relativePath;
    $("project-list-card").hidden = true;
    $("project-register").hidden = true;
    $("project-workspace-layout").hidden = true;
    $("project-file-errors").hidden = true;
    $("project-browser").hidden = false;
    $("project-browser-title").textContent = project.title || project.name;
    window.CeasefireI18n.text($("project-browser-status"), "Reading project folder…"); $("project-browser-message").hidden = true;
    list.setAttribute("aria-busy", "true"); list.replaceChildren(uiNode("p", "empty-state", "Reading files and folders…"));
    try {
      const data = await request("/api/projects/files", { method: "POST", body: JSON.stringify({ id: project.id, relative_path: relativePath }) });
      if (revision !== state.projectBrowserRevision || state.projectBrowserProject?.id !== project.id) return;
      state.projectBrowserPath = data.relative_path || ""; renderProjectBreadcrumbs(data.project, state.projectBrowserPath);
      const entries = (data.entries || []).map(entry => {
        const button = node("button", "project-browser-entry"); button.type = "button";
        const symbol = projectFileIcon(entry);
        const name = node("span", "project-browser-entry-name", entry.name);
        const meta = entry.type === "folder" ? uiNode("span", "project-browser-entry-meta", "Folder") : node("span", "project-browser-entry-meta", [projectFileSize(entry.size), entry.modified_at ? new Date(entry.modified_at).toLocaleString("en-AU") : ""].filter(Boolean).join(" · "));
        button.append(symbol, name, meta);
        window.CeasefireI18n.attr(button, "aria-label", entry.type === "folder" ? "Open folder {0}" : "Open {0} in its default application", [entry.name]);
        button.addEventListener("click", () => entry.type === "folder" ? loadProjectFiles(data.project, entry.relative_path) : openProjectFolderFile(data.project, entry, button));
        return button;
      });
      list.replaceChildren(...(entries.length ? entries : [uiNode("p", "empty-state", "This folder is empty.")]));
      window.CeasefireI18n.text($("project-browser-status"), "{0} {1}", [entries.length.toLocaleString("en-AU"), window.CeasefireI18n.term(entries.length === 1 ? "entry" : "entries")]);
      const problems = (data.errors || []).map(item => `${item.name}: ${item.error}`);
      $("project-browser-message").textContent = problems.join("\n"); $("project-browser-message").className = "message error"; $("project-browser-message").hidden = !problems.length;
    } catch (error) {
      if (revision === state.projectBrowserRevision) {
        list.replaceChildren(node("p", "message error", error.message)); window.CeasefireI18n.text($("project-browser-status"), "Project folder unavailable");
      }
    } finally { if (revision === state.projectBrowserRevision) list.setAttribute("aria-busy", "false"); }
  }

  function openProjectBrowser(file) {
    return loadProjectFiles({ id: file.id, title: file.title || file.name, name: file.name }, "");
  }

  async function downloadFullReport(materials, button) {
    if (button.disabled || state.projectBusy) return;
    const context = state.quoteContext;
    button.disabled = true; button.setAttribute("aria-busy", "true");
    const endSound = window.CeasefireDownloadSound?.begin();
    try {
      await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]);
      if (context !== state.quoteContext) throw new Error("The project changed. Download the report again.");
      const calculators = Object.fromEntries(Object.entries(window.CeasefireCalculators.projectSnapshot()).map(([id, value]) => [id, { inputs: value.inputs }]));
      const takeoffSession = window.CeasefireTakeoffs?.sessionId?.();
      const payload = { calculators, penetration: window.CeasefirePenetrations.projectSnapshot().draft,
        configuration: clone(state.quoteConfiguration || state.configuration), project_details: quoteDetails(), ...(takeoffSession ? { takeoff_session_id: takeoffSession } : {}) };
      const saved = await window.CeasefireDownloads.save(`/api/project/${materials ? "full-product-summary" : "full-schedule"}.pdf`, payload, { button });
      message(uiCopy("PDF saved to {0}. It includes the schedule inputs captured when the download was prepared.", [saved.path]));
      return saved;
    } catch (error) { message(error.message, true); }
    finally { endSound?.(); button.disabled = false; button.removeAttribute("aria-busy"); }
  }

  async function downloadQuotePdf(button = $("download-quote-pdf")) {
    if (inputProblem()) { message(inputProblem(), true); return; }
    if (button.disabled) return;
    const payload = reportPayload();
    const quoteContext = state.quoteContext;
    const capturedPayload = JSON.stringify(payload);
    const penetrationStamp = window.CeasefirePenetrations?.quoteFingerprint?.();
    const savedReportId = state.quote && !state.dirty ? state.quote.id : null;
    const reportPath = savedReportId ? `/api/quotes/${encodeURIComponent(savedReportId)}/report.pdf` : "/api/quote-report";
    button.disabled = true;
    window.CeasefireI18n.attr(button, "aria-label", "Preparing document…");
    button.setAttribute("aria-busy", "true");
    try {
      const saved = await window.CeasefireDownloads.save(reportPath, savedReportId ? {} : payload, { button });
      const estimateChanged = quoteContext !== state.quoteContext || capturedPayload !== JSON.stringify(reportPayload()) || window.CeasefirePenetrations?.quoteFingerprint?.() !== penetrationStamp;
      message(estimateChanged ? uiCopy("PDF saved to {0} for “{1}” using {2}. Later edits are not included.", [saved.path, payload.title, window.CeasefireI18n.term(savedReportId ? "its saved result and pricing snapshot" : "the inputs and pricing captured when you clicked Breakdown")]) : uiCopy("PDF saved to {0} for “{1}”.", [saved.path, payload.title]));
      return saved;
    } catch (error) { message(uiCopy("PDF for “{0}” was not downloaded. {1}", [payload.title, error.message]), true); }
    finally {
      button.disabled = false;
      window.CeasefireI18n.attr(button, "aria-label", "Breakdown");
      button.removeAttribute("aria-busy");
    }
  }

  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", event => {
    if (button.id === "settings-navigation-toggle" && event.pointerType === "touch") return;
    if (button.id === "calculator-navigation-toggle") return requestCalculatorNavigation();
    if (button.id === "documents-navigation-toggle") return requestDocumentsNavigation();
    return requestViewNavigation(button.dataset.view);
  });
  for (const button of projectPages?.querySelectorAll("[data-project-section]") || []) button.addEventListener("click", () => requestViewNavigation(button.dataset.projectSection));
  for (const card of document.querySelectorAll(".projects-section-card[data-document-section]")) card.addEventListener("click", () => requestViewNavigation(card.dataset.documentSection));
  for (const button of documentPages?.querySelectorAll("[data-document-section]") || []) button.addEventListener("click", () => requestViewNavigation(button.dataset.documentSection));
  for (const card of document.querySelectorAll("[data-steel-calculator]")) card.addEventListener("click", () => requestCalculatorNavigation(card.dataset.steelCalculator));
  setupWorkspaceTabs("calculator-kind-pages", "[data-calculator-id]", button => requestCalculatorNavigation(button.dataset.calculatorId));
  setupWorkspaceTabs("library-pages", "[data-library-kind]", button => requestLibraryNavigation(button.dataset.libraryKind));
  setupWorkspaceTabs("takeoff-pages", "[data-mode]", button => requestTakeoffNavigation(button.dataset.mode, button.dataset.physicalScope));
  setupCalculatorNavigation();
  for (const button of document.querySelectorAll("[data-home-view]")) button.addEventListener("click", () => requestViewNavigation(button.dataset.homeView));
  document.querySelector(".brand")?.addEventListener("click", (event) => { event.preventDefault(); requestViewNavigation("home"); });
  for (const id of Object.values(projectDetailControls)) $(id).addEventListener("input", () => { updateQuoteTitle(); updateDirty(); window.CeasefireCommercial?.projectDetailsChanged?.(); });
  $("measurements").addEventListener("input", () => updateDirty());
  $("new-quote").addEventListener("click", async () => { if (!state.projectBusy && !coverReplacementPending()) await window.CeasefireProjectPane?.openNew?.(); });
  $("download-quote-pdf").addEventListener("click", () => downloadQuotePdf());
  for (const id of ["estimate-open-quote"]) $(id).addEventListener("click", async () => {
    if (!requireCreatedProject()) return;
    const context = state.quoteContext;
    if (await requestViewNavigation("quote") && state.currentView === "quote" && context === state.quoteContext) await window.CeasefireCommercial?.openFromEstimate?.();
  });
  for (const [id, label, materials] of [["download-full-schedule", "Full Schedule", false], ["download-full-product-summary", "Full Product Summary", true]]) {
    const button = node("button", "button pdf-button calculator-document-action"); button.id = id; button.type = "button";
    const icon = node("span", "download-format-icon"); icon.setAttribute("aria-hidden", "true");
    icon.append(node("span", "download-arrow", "⇩"), node("span", "download-format", "PDF"));
    button.append(icon, uiNode("span", "", label)); button.addEventListener("click", () => downloadFullReport(materials, button));
    $("firestopping-document-actions").append(button);
  }
  // Keep pointer activation from moving the editor's caret before the modal
  // opens. Native dialog focus restoration returns to the invoking control.
  $("header-project-name").addEventListener("mousedown",event => {
    if (event.button === 0) event.preventDefault();
  });
  async function openHeaderProjectDetails() {
    if (state.projectBusy) return;
    if (state.projectFile?.title?.trim()) return window.CeasefireProjectPane.showHeaderDetails();
    if (state.currentView === "quotes" && !await window.CeasefireProjectPane.leave()) return;
    return requestViewNavigation("quotes");
  }
  $("header-project-name").addEventListener("click",openHeaderProjectDetails);
  $("save-current-project").addEventListener("click", saveProject);
  $("load-project").addEventListener("click", async () => { if (await confirmLeavePricingLibrary()) openNativeProject(); });
  $("project-import-file").addEventListener("change", loadProject);
  $("project-attachment-zone").addEventListener("click", chooseProjectFiles);
  $("project-attachment-input").addEventListener("change", event => uploadProjectFiles(event.target.files));
  for (const eventName of ["dragenter", "dragover"]) $("project-attachment-zone").addEventListener(eventName, event => {
    event.preventDefault(); if (!state.projectBusy) $("project-attachment-zone").classList.add("is-dragover");
  });
  for (const eventName of ["dragleave", "dragend"]) $("project-attachment-zone").addEventListener(eventName, () => $("project-attachment-zone").classList.remove("is-dragover"));
  $("project-attachment-zone").addEventListener("drop", event => {
    event.preventDefault(); $("project-attachment-zone").classList.remove("is-dragover"); uploadProjectFiles(event.dataTransfer?.files);
  });
  $("refresh-quotes").addEventListener("click", () => state.projectBrowserProject
    ? loadProjectFiles(state.projectBrowserProject, state.projectBrowserPath)
    : loadProjects({ refresh: true, offset: 0 }));
  $("project-search").addEventListener("input", () => {
    clearTimeout(state.projectsTimer); ++state.projectsRevision;
    state.projectsTimer = setTimeout(() => loadProjects({ offset: 0 }), 250);
  });
  $("project-sort").addEventListener("change", () => loadProjects({ offset: 0 }));
  const projectColumnOptions = $("project-columns").querySelector(".commercial-menu-options");
  for (const stage of projectStatuses) {
    const label = node("label", "commercial-check");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenProjectStages.has(stage);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) hiddenProjectStages.delete(stage);
      else hiddenProjectStages.add(stage);
      applyProjectColumnVisibility();
      try { localStorage.setItem(projectColumnsKey, JSON.stringify([...hiddenProjectStages])); }
      catch { /* Keep this session's selection when storage is unavailable. */ }
    });
    label.append(checkbox, uiNode("span", "", stage));
    projectColumnOptions.append(label);
  }
  const currentEstimateName = $("project-estimate-current-name");
  currentEstimateName.addEventListener("input", () => {
    editingEstimateName = state.projectEstimates.find(entry => entry.id === state.activeEstimateId);
    updateProjectStatus();
  });
  currentEstimateName.addEventListener("blur", finishEstimateName);
  currentEstimateName.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      if (event.key === "Escape" && editingEstimateName) currentEstimateName.value = editingEstimateName.name;
      currentEstimateName.blur();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const select = $("project-estimate-select");
      select.focus();
      select.showPicker?.();
    }
  });
  $("project-estimate-select").addEventListener("change", () => selectEstimate($("project-estimate-select").value));
  $("project-estimate-new").addEventListener("click", addProjectEstimate);

  const estimateWidth = () => {
    const width = $("project-no")?.getBoundingClientRect().width;
    if (width > 0) $("project-estimate-select").closest(".field").style.flexBasis = `${width}px`;
  };
  if (window.ResizeObserver) new ResizeObserver(estimateWidth).observe($("project-no"));
  $("project-previous").addEventListener("click", () => loadProjects({ offset: Math.max(0, state.projectsOffset - 100) }));
  $("project-next").addEventListener("click", () => loadProjects({ offset: state.projectsOffset + 100 }));
  $("project-continue").addEventListener("click", () => loadProjects());
  $("link-project-folder").addEventListener("click", linkProjectFolder);
  $("project-browser-close").addEventListener("click", closeProjectBrowser);
  $("use-current-pricing").addEventListener("click", useCurrentPricing);
  $("pricing-scope").addEventListener("change", () => requestPricingScopeSwitch($("pricing-scope").value));
  $("pricing-search").addEventListener("input", renderPricing);
  $("rate-group").addEventListener("change", renderPricing);
  $("add-pricing-item").addEventListener("click", addPricingItem);
  $("save-pricing").addEventListener("click", requestSavePricing);
  $("reset-pricing").addEventListener("click", resetPricingLibrary);
  $("export-pricing").addEventListener("click", () => exportPricing());
  $("import-pricing").addEventListener("click", () => $("pricing-import-file").click());
  $("pricing-import-file").addEventListener("change", importPricing);
  $("discard-pricing").addEventListener("click", async () => {
    document.activeElement?.blur?.();
    const draft = state.draft, revision = state.pricingRevision;
    if (state.pricingDirty && !await confirmReplace(uiCopy("Discard pricing changes?"), uiCopy(state.pricingScope === "project" ? "Project pricing edits will return to the last applied project prices." : "Shared library edits will return to the last saved library."), uiCopy("Discard changes"))) return;
    if (draft !== state.draft || revision !== state.pricingRevision) return;
    state.draft = clone(pricingBaseline()); refreshPricingCatalog(); renderPricing(); message(uiCopy("Unsaved pricing changes discarded."));
  });
  window.addEventListener("resize", () => {
    // An intentional layout change may release retired space. Keep a captured
    // drawing pointer stable until its gesture has ended.
    if ($("app-message").hidden && !document.querySelector(".takeoff-viewport:active")) releaseMessageSpace();
  });
  window.addEventListener("beforeunload", (event) => {
    if (window.ClassifireAccess?.signedOut) return;
    const pricingChanged = sharedPricingChanged();
    if (projectHasChanges() || pricingChanged || window.CeasefireScheduler?.hasPendingOperation?.() || window.CeasefireLibraryEditor?.hasUnsavedChanges() || window.CeasefireCertification?.hasUnsavedChanges?.() || window.CeasefireCoverSheets?.hasUnsavedChanges?.() || window.CeasefirePersonalDetails?.hasUnsavedChanges?.() || window.CeasefireProjectPane?.hasUnsavedChanges?.() || window.ClassifireContacts?.hasUnsavedChanges?.() || window.ClassifireContacts?.hasPendingOperation?.()) {
      event.preventDefault(); event.returnValue = pricingChanged ? pricingUnsavedPrompt : "";
    }
  });
  // The desktop shell asks this page to review a close request; it never reads
  // calculator internals or assumes that the browser's unload dialog will run.
  let desktopInputRevision = 0, desktopClosePending = false;
  window.addEventListener("input", () => { desktopInputRevision++; }, true);
  window.addEventListener("change", () => { desktopInputRevision++; }, true);
  function desktopCloseStamp() { return JSON.stringify({ project: projectStamp(), input: desktopInputRevision, pricing: sharedPricingDraft(), pricingRevision: state.pricingRevision, libraryDirty: !!window.CeasefireLibraryEditor?.hasUnsavedChanges(), certification: window.CeasefireCertification?.fingerprint?.(), coverSheets:window.CeasefireCoverSheets?.fingerprint?.(), personalDetails:window.CeasefirePersonalDetails?.fingerprint?.(), projectPane:window.CeasefireProjectPane?.fingerprint?.(), contacts:window.ClassifireContacts?.fingerprint?.() }); }
  function desktopBusy() { return window.ClassifirePassiveRegister?.busy() || state.projectBusy || state.desktopRequests > 0 || !!window.CeasefireSWMS?.hasPendingOperation?.() || !!window.CeasefireCommercial?.hasPendingOperation?.() || !!window.CeasefireDownloads?.hasPendingOperation?.() || !!document.querySelector('dialog[open], [aria-busy="true"]') || !state.initialized || !!window.CeasefireCalculators?.hasPendingOperation?.() || !!window.CeasefirePenetrations?.hasPendingOperation?.() || !!window.CeasefireTakeoffs?.hasPendingOperation?.() || !!window.CeasefireLibraryEditor?.hasPendingOperation?.() || !!window.CeasefireCertification?.hasPendingOperation?.() || !!window.CeasefireCoverSheets?.hasPendingOperation?.() || !!window.CeasefireDocumentation?.hasPendingOperation?.() || !!window.CeasefirePersonalDetails?.hasPendingOperation?.() || !!window.CeasefireProjectPane?.hasPendingOperation?.() || !!window.ClassifireContacts?.hasPendingOperation?.(); }
  async function reviewDesktopClose() {
    if (desktopBusy()) { message(uiCopy("Finish the current operation or dialog before closing ESTIMATOR."), true); return false; }
    finishEstimateName();
    const captured = desktopCloseStamp();
    if (projectHasChanges() || sharedPricingChanged() || window.CeasefireLibraryEditor?.hasUnsavedChanges() || window.CeasefireCertification?.hasUnsavedChanges?.() || window.CeasefireCoverSheets?.hasUnsavedChanges?.() || window.CeasefirePersonalDetails?.hasUnsavedChanges?.() || window.CeasefireProjectPane?.hasUnsavedChanges?.() || window.ClassifireContacts?.hasUnsavedChanges?.()) {
      if (!await confirmReplace(uiCopy("Close ESTIMATOR?"), uiCopy(window.CeasefirePersonalDetails?.hasUnsavedChanges?.() || window.ClassifireContacts?.hasUnsavedChanges?.() ? "There are unsaved changes. Close without saving discards them. Keep editing to save them first." : "There are unsaved project, calculator, library, certification or cover-sheet edits. Close without saving discards these edits. Keep editing to save them first."), uiCopy("Close without saving"))) return false;
    }
    if (desktopBusy() || captured !== desktopCloseStamp()) { message(uiCopy("Your draft changed during the close review. Close again when ready to keep your latest edits safe."), true); return false; }
    return true;
  }
  window.CeasefireDesktop = {
    showHome() { showView("home"); },
    status() { return { ready: state.initialized, takeoffs: state.takeoffsEnabled, dirty: !!(projectHasChanges() || sharedPricingChanged() || window.CeasefireLibraryEditor?.hasUnsavedChanges() || window.CeasefireCertification?.hasUnsavedChanges?.() || window.CeasefireCoverSheets?.hasUnsavedChanges?.() || window.CeasefirePersonalDetails?.hasUnsavedChanges?.() || window.CeasefireProjectPane?.hasUnsavedChanges?.() || window.ClassifireContacts?.hasUnsavedChanges?.()), busy: desktopBusy() }; },
    async requestClose(nonce) {
      const host = window.chrome?.webview;
      if (!host || !/^[a-f0-9]{64}$/.test(nonce || "")) return;
      const reply = (action, allowed = false) => host.postMessage({ type: "ceasefire.close", action, nonce, allowed });
      if (desktopClosePending) { reply("resolve", false); return; }
      desktopClosePending = true; let allowed = false;
      try { reply("ack"); allowed = await reviewDesktopClose(); }
      catch (error) { message(uiCopy("ESTIMATOR was not closed. {0}", [error.message]), true); }
      finally { desktopClosePending = false; reply("resolve", allowed); }
    },
  };
  function scheduleChanged() {
    const stamp = window.CeasefirePenetrations?.quoteFingerprint?.();
    if (stamp === state.firestoppingStamp) return;
    const hadSchedule = state.firestoppingStamp !== undefined;
    state.firestoppingStamp = stamp;
    if (state.initialized) { if (hadSchedule) updateDirty(); scheduleCalculation(); }
  }
  function isCurrentDownloadTarget(target) {
    return !!target && target.project_context === state.quoteContext &&
      typeof target.project_path === "string" && target.project_path === state.projectFile?.path;
  }
  async function openConvertedLead(receipt, button) {
    if (!receipt || typeof receipt.project_no !== "string" || (!receipt.project_source && typeof receipt.path !== "string")) throw new Error("The converted project could not be identified. Open it from Projects.");
    if (state.projectBusy) throw new Error("The project was saved. Finish the current project action and open it from Projects.");
    // Conversion returns the saved receipt, never a caller-selected file path.
    // Resolve its opaque identity through the normal linked-folder listing.
    for (let attempt = 0; attempt < 100; attempt++) {
      const listing = await request(`/api/projects?search=${encodeURIComponent(receipt.project_no)}`);
      const file = listing.files?.find(file => file.project_no === receipt.project_no &&
        (receipt.project_source ? file.source === receipt.project_source : file.path === receipt.path));
      if (file) {
        if (button) return openLinkedProject({source:file.source, owner:file.source_project_id || "", project_no:file.project_no}, button);
        return openProjectFile(file, node("button"), null, {convertedLead:true});
      }
      if (!listing.scan_pending) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("The project was saved, but could not be opened automatically. Open it from Projects.");
  }
  window.CeasefireProject = { details: quoteDetails, changed: updateProjectStatus, scheduleChanged, hasCreatedProject, requireCreatedProject, createProject, discardNewProject, refreshPages: refreshProjectPages,
    projectPaneSnapshot: () => ({details:{...quoteDetails(),follow_up_actions:clone(projectFollowUp.actions)}, context:state.quoteContext, file:state.projectFile ? clone(state.projectFile) : null, busy:state.projectBusy}),
    applyProjectPaneDraft(details, context) {
      if (context !== state.quoteContext) throw new Error("The current project changed. Open its details again.");
      const {identity, followUp} = splitProjectDetails(details);
      projectFollowUp = {...projectFollowUp, actions:followUp.actions};
      applyQuoteDetails(identity);
      for(const entry of state.projectEstimates)if(entry.workspace?.estimate) {
        const number=entry.workspace.estimate.project_no;
        Object.assign(entry.workspace.estimate,identity,{project_no:number});
        entry.workspace.estimate.title=[number,details.client,(details.site_address || '').replace(/\s+/g,' ')].filter(Boolean).join('- ') || entry.workspace.estimate.title;
      }
      updateQuoteTitle(); updateDirty();
      window.CeasefireCommercial?.projectDetailsChanged?.();
    },
    captureCommercialDetailsEdit() {
      return {context:state.quoteContext,dirty:state.dirty,guard:commercialDetailsGuard(),estimates:Object.fromEntries(state.projectEstimates.filter(entry=>entry.workspace?.estimate).map(entry=>
        [entry.id,Object.fromEntries(['title',...Object.keys(projectDetailControls)].filter(key=>Object.hasOwn(entry.workspace.estimate,key)).map(key=>[key,entry.workspace.estimate[key]]))]))};
    },
    applyCommercialDetails(patch, context, baseline=null) {
      if(context!==state.quoteContext || state.projectBusy)throw new Error("The current project changed. Open its details again.");
      const details={...quoteDetails()};
      for(const key of Object.keys(projectDetailControls))if(key!=='project_no' && Object.hasOwn(patch,key))details[key]=String(patch[key] ?? '').trim();
      applyQuoteDetails(details);
      for(const entry of state.projectEstimates)if(entry.workspace?.estimate) {
        const estimate=entry.workspace.estimate,number=estimate.project_no,original=baseline?.context===state.quoteContext ? baseline.estimates?.[entry.id] : null;
        for(const key of Object.keys(patch))if(key!=='project_no' && Object.hasOwn(projectDetailControls,key)) {
          if(original && !Object.hasOwn(original,key))delete estimate[key];
          else estimate[key]=original ? original[key] : details[key];
        }
        // A legacy workspace can have a custom title and distinct imported
        // identity. Restore those exact values only when its identity matches.
        const restored=original && Object.keys(projectDetailControls).every(key=>estimate[key]===original[key]);
        estimate.title=restored ? original.title : [number,estimate.client,(estimate.site_address || '').replace(/\s+/g,' ')].filter(Boolean).join('- ') || estimate.title;
      }
      updateQuoteTitle();
      const unchanged=baseline?.context===state.quoteContext && baseline.guard===commercialDetailsGuard();
      updateDirty(unchanged ? baseline.dirty : true);
      window.CeasefireProjectPane?.projectDetailsChanged?.();
    },
    applyProjectPaneSaved(snapshot, result, expectedRevision) {
      const current = state.projectFile;
      if (!current || snapshot.context !== state.quoteContext || current.path !== result.file?.path || current.path !== snapshot.file?.path || current.revision !== snapshot.file.revision || current.revision !== expectedRevision) return false;
      // Metadata saves must never mark an estimate, calculator or pricing draft saved.
      // Rebase only identity fields; every other workspace value stays untouched.
      state.projectFile = result.file;
      const {identity, followUp} = splitProjectDetails(result.details);
      savedProjectFollowUp = followUpFields(result.project_follow_up ?? followUp);
      for (const entry of state.projectEstimates) if (entry.workspace?.estimate) {
        const estimate = entry.workspace.estimate;
        const projectNo = estimate.project_no;
        Object.assign(estimate, identity, {project_no:projectNo});
        estimate.title = [estimate.project_no, estimate.client, (estimate.site_address || "").replace(/\s+/g," ")].filter(Boolean).join("- ") || estimate.title;
      }
      if (JSON.stringify({...quoteDetails(),follow_up_actions:projectFollowUp.actions}) === JSON.stringify(snapshot.details)) {
        applyQuoteDetails({...identity,project_no:snapshot.details.project_no});
        projectFollowUp = savedProjectFollowUp;
      } else {
        projectFollowUp = {...savedProjectFollowUp, actions:projectFollowUp.actions};
      }
      updateQuoteTitle(); updateProjectStatus();
      window.CeasefireCommercial?.projectDetailsChanged?.();
      return true;
    },
    refreshProjectCards: () => loadProjects(),
    openConvertedLead,openLinkedProject,
    openCommercial: kind => requestViewNavigation({quote:"quote", work_order:"work-orders", purchase_order:"purchase-orders"}[kind]),
    openScheduler: () => requestViewNavigation("scheduler"),
    configuration: () => clone(state.quoteConfiguration || state.configuration),
    context: () => ({project_token:state.projectFile?.save_token || null,project_context:state.quoteContext,project_path:state.projectFile?.path || null,project_revision:state.projectFile?.revision || null}),
    runtimeContext: () => state.quoteContext,
    hasPendingOperation: () => state.projectBusy,
    isCurrentDownloadTarget,
    downloadTarget() {
      // Schedules also read this identity to guard deletion reviews. Reading
      // an unsaved project's identity must not prevent worksheet rendering.
      return { project_token: state.projectFile?.save_token || null, project_context: state.quoteContext, project_path: state.projectFile?.path || null };
    },
    saveAfterDownload: target => saveProject({ automatic: true, downloadTarget: target }),
    downloadSaveFailed(target, result, error) {
      if (isCurrentDownloadTarget(target)) message(uiCopy("File saved to {0}, but the project was not saved. {1}", [result.path, error.message]), true);
    } };
  window.CeasefireDocumentationApp = { async run(adapter, spec, button) {
    if (adapter === "passive_fire_register") { window.ClassifirePassiveRegister.setOptions(spec.options); await requestViewNavigation("passive-fire-register"); return {selectionRequired:true}; }
    if (adapter === "swms") { await requestViewNavigation("swms"); return {selectionRequired:true}; }
    if (adapter === "commercial") {
      const owner = {context:state.quoteContext, workspace:window.CeasefireCertification.sessionId(), actor:window.ClassifireAccess?.user?.id};
      const opened = await requestViewNavigation({quote:"quote",work_order:"work-orders",purchase_order:"purchase-orders"}[spec.kind], undefined, owner);
      return {selectionRequired:opened};
    }
    if (adapter === "pricing") return exportPricing(button);
    if (adapter === "estimate") {
      if (spec.action === "summary") return downloadQuotePdf(button);
      return downloadFullReport(spec.action === "full_product_summary",button);
    }
    if (adapter === "certification") { await requestViewNavigation("certification"); return {selectionRequired:true}; }
    throw new Error("Choose a supported project document.");
  } };
  window.CeasefireLibraryNavigation = { open: requestLibraryNavigation };
  window.CeasefireDialogs = { confirm: confirmReplace, notify, message };
  window.CeasefireTakeoffNavigation = { show() { return showView("takeoffs"); } };
  window.CeasefirePenetrationNavigation = {
    show() { return showView("calculators", undefined, "penetration"); },
    showSchedule() {
      const quoteContext = state.quoteContext;
      const opened = showView("calculators", undefined, "penetration");
      // Retain schedule navigation's calculation contract after moving its
      // visible table into Calculators. A blocked or superseded navigation
      // must not start work in another view or a replacement project.
      if (!opened) return opened;
      return Promise.resolve(opened).then(() => {
        if (quoteContext !== state.quoteContext || state.currentView !== "calculators" || state.calculatorKind !== "penetration") return;
        return window.CeasefirePenetrations?.openSchedule?.();
      });
    },
    confirm: confirmReplace,
    confirmDelete() { return confirmReplace(uiCopy("Delete item?"), uiCopy("Are you sure you want to delete this item?"), uiCopy("Yes"), uiCopy("Cancel")); },
    message(text, error = false, args = []) { message(uiCopy(text, args), error); },
    notify,
  };
  window.CeasefireLibraryEditorNavigation = {
    show() { document.activeElement?.blur?.(); showView("calculators", undefined, "penetration"); },
    returnToLibrary(id) { state.libraryKind = "penetration"; showView("pricing", id); },
  };
  window.CeasefireProposalCalculators = {
    showFirestopping() { return showView("calculators", undefined, "penetration"); },
    showWorkbook() { state.estimatorKind = "estimate"; $("estimator-penetration").hidden = true; },
    isFirestopping() { return state.estimatorKind === "penetration"; },
    isSteelHub() { return false; },
  };
  bootstrap();
})();
