(() => {
  "use strict";
  const state = { workspace: null, model: null, editor: null, options: null, busy: false, dirty: false, changed: false, revision: 0, search: "", peopleDefaults: null, peopleDesired: {}, peopleSaving: null, peopleTimer: null, peopleError: null, peopleSeedEligible: true };
  const copy = value => JSON.parse(JSON.stringify(value));
  const root = () => document.getElementById("swms-root");
  const workspace = () => window.CeasefireCertification?.sessionId?.();
  const context = () => window.CeasefireProject?.runtimeContext?.();
  const element = (tag, className = "", text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  function notice(text, error = false) {
    const target = root()?.querySelector(".swms-message");
    if (target) {
      target.textContent = text; target.hidden = !text; target.classList.toggle("error", error);
      if (error && state.peopleError?.status === 409) target.append(document.createTextNode(" "), button("Keep saved defaults", keepPeopleDefaults));
    }
  }
  function changed() { state.changed = true; window.CeasefireProject?.changed?.(); }
  function dirty() { state.dirty = true; if (state.editor) state.editor.pendingIssue = null; window.CeasefireProject?.changed?.(); }
  function button(label, action, primary = false) {
    const result = element("button", `button ${primary ? "primary" : "secondary"}`, label);
    result.type = "button";
    result.addEventListener("click", () => Promise.resolve(action()).catch(error => notice(error.message, true)));
    return result;
  }
  function control(value, update, type = "text") {
    const result = element(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") result.type = type;
    else result.rows = 3;
    result.value = value || "";
    result.maxLength = type === "textarea" ? 30000 : 1000;
    result.addEventListener("input", () => { update(result.value); dirty(); });
    return result;
  }
  function select(options, value, update) {
    const result = element("select");
    options.forEach(item => { const option = element("option", "", item); option.value = item; result.append(option); });
    result.value = value;
    result.addEventListener("change", () => { update(result.value); dirty(); });
    return result;
  }
  function field(label, input) {
    const result = element("label", "field"); input.setAttribute("aria-label", label);
    result.append(element("span", "", label), input); return result;
  }
  function check(label, checked, update) {
    const input = element("input"); input.type = "checkbox"; input.checked = checked;
    input.addEventListener("change", () => { update(input.checked); dirty(); });
    const result = element("label", "swms-check"); result.append(input, element("span", "", label)); return result;
  }
  function section(title, opened = false) {
    const result = element("details", "card swms-section"); result.open = opened;
    result.append(element("summary", "", title)); return result;
  }
  function shell(title) {
    const host = root(); host.replaceChildren();
    const heading = element("div", "page-heading"), titleNode = element("h1", "", title);
    window.CeasefireI18n?.text(titleNode, title); heading.append(titleNode);
    const message = element("p", "swms-message message"); message.setAttribute("role", "status"); message.hidden = true;
    host.append(heading, message); return host;
  }
  async function request(action, body) {
    const response = await fetch(`/api/swms/${action}`, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || "The SWMS request failed."); error.status = response.status; throw error; }
    return data;
  }
  function guard() {
    const revision = state.revision, capturedWorkspace = state.workspace, capturedContext = context();
    return () => revision === state.revision && capturedWorkspace === state.workspace && capturedWorkspace === workspace() && capturedContext === context();
  }
  function lock(value) {
    state.busy = value;
    root()?.querySelectorAll("button,input,select,textarea").forEach(item => {
      if (value) { item.dataset.swmsDisabled = item.disabled ? "yes" : "no"; item.disabled = true; }
      else if (item.dataset.swmsDisabled) { item.disabled = item.dataset.swmsDisabled === "yes"; delete item.dataset.swmsDisabled; }
    });
    root()?.setAttribute("aria-busy", String(value));
  }
  async function load() {
    const current = guard();
    const result = await request(`state?workspace=${encodeURIComponent(state.workspace)}`);
    if (!current()) return false;
    state.model = result; return true;
  }
  async function activate() {
    if (!root()) return;
    if (state.busy) return;
    if (state.workspace === workspace() && state.editor) { renderEditor(); return; }
    const revision = ++state.revision, capturedContext = context();
    shell("Safe Work Method Statements");
    try {
      const identity = workspace() || (await window.CeasefireCertification.projectWorkspace()).workspace_id;
      if (revision !== state.revision || capturedContext !== context() || identity !== workspace()) return;
      state.workspace = identity;
      if (await load()) renderList();
    } catch (error) { if (revision === state.revision) notice(error.message, true); }
  }
  function renderList() {
    clearTimeout(state.peopleTimer); state.peopleTimer = null; state.peopleDesired = {}; state.peopleError = null;
    state.editor = null; state.dirty = false;
    const host = shell("Safe Work Method Statements"), bar = element("div", "swms-toolbar");
    const search = element("input"); search.type = "search"; search.value = state.search;
    search.placeholder = "Title, project or site address…";
    search.addEventListener("input", () => { state.search = search.value; cards(); });
    bar.append(field("Search statements", search), button("New SWMS", openNew, true)); host.append(bar, element("div", "swms-list")); cards();
  }
  function cards() {
    const host = root().querySelector(".swms-list"); host.replaceChildren();
    const rows = (state.model?.documents || []).filter(row => [row.fields.title, ...Object.values(row.fields.details)].join(" ").toLowerCase().includes(state.search.toLowerCase())).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (!rows.length) host.append(element("p", "muted", "No statements found. Create a SWMS for this project."));
    rows.forEach(row => {
      const card = element("article", "card swms-card"), actions = element("div", "actions");
      card.append(element("h2", "", row.fields.title), element("span", "badge", row.status), element("p", "", [row.fields.details.job_reference, row.fields.details.project_address].filter(Boolean).join(" · ")),
        element("p", "muted", `Revision ${row.version} · Updated ${new Date(row.updated_at).toLocaleString("en-AU")}`));
      actions.append(button("Open", () => open(row)), button("Delete", () => remove(row))); card.append(actions); host.append(card);
    });
  }
  async function defaults() {
    const details = window.CeasefireProject?.details?.() || {};
    return request("defaults", { workspace_id: state.workspace, details: { project_no: details.project_no || "", client: details.client || "", site_address: details.site_address || "" } });
  }
  function queuePeople(key) {
    if (!["reviewers", "consultation"].includes(key)) return;
    state.peopleDesired[key] = copy(state.editor.fields[key]);
    clearTimeout(state.peopleTimer);
    state.peopleTimer = setTimeout(() => flushPeopleDefaults().catch(error => notice(error.message, true)), 350);
  }
  function peoplePending() { return !!state.peopleSaving || !!state.peopleError || !!Object.keys(state.peopleDesired).length; }
  async function keepPeopleDefaults() {
    if (state.busy || !state.editor) return;
    const current = guard(), editor = state.editor; lock(true);
    try {
      const result = await defaults();
      if (!current() || editor !== state.editor) return;
      clearTimeout(state.peopleTimer); state.peopleTimer = null;
      state.peopleDefaults = result.people_defaults; state.peopleDesired = {}; state.peopleError = null;
      state.peopleSeedEligible = false;
      notice("Saved defaults retained. Your statement edits are unchanged; choose Save to save this statement.");
    } finally { if (current()) lock(false); }
  }
  async function flushPeopleDefaults() {
    clearTimeout(state.peopleTimer); state.peopleTimer = null;
    if (state.peopleSaving) return state.peopleSaving;
    if (state.peopleError?.status === 409) throw state.peopleError;
    const current = guard();
    state.peopleSaving = (async () => {
      while (Object.keys(state.peopleDesired).length) {
          const key = Object.keys(state.peopleDesired)[0];
          const rows = copy(state.peopleDesired[key]);
          const saved = await request("people-defaults", {workspace_id: state.workspace, section:key, rows, expected_version:state.peopleDefaults[key].version});
          if (!current()) return false;
          state.peopleDefaults[key] = saved; state.peopleError = null;
          if (JSON.stringify(state.peopleDesired[key]) === JSON.stringify(rows)) delete state.peopleDesired[key];
      }
      return true;
    })();
    try { return await state.peopleSaving; }
    catch (error) { state.peopleError = error; throw error; }
    finally { state.peopleSaving = null; }
  }
  async function openNew() {
    if (state.busy) return;
    const current = guard(); lock(true);
    try {
      const result = await defaults(); if (!current()) return;
      state.options = result.options; state.peopleDefaults = result.people_defaults; state.peopleSeedEligible = true; state.editor = { id: crypto.randomUUID(), version: 0, status: "Draft", fields: result.fields };
      state.dirty = true; renderEditor(); window.CeasefireProject?.changed?.();
    } finally { if (current()) lock(false); }
  }
  async function open(row) {
    if (state.busy) return;
    const current = guard(); lock(true);
    try {
      const result = await defaults(); if (!current()) return; state.options = result.options; state.peopleDefaults = result.people_defaults; state.peopleSeedEligible = true;
      state.editor = copy(row); state.dirty = false; renderEditor();
    } finally { if (current()) lock(false); }
  }
  async function remove(row) {
    if (state.busy || !window.confirm(`Delete “${row.fields.title}” from this project?`)) return;
    const current = guard(); lock(true);
    try { await request("delete", { workspace_id: state.workspace, id: row.id, version: row.version }); if (!current()) return; changed(); if (await load()) renderList(); }
    finally { if (current()) lock(false); }
  }
  async function save({seedDefaults = false} = {}) {
    if (state.busy || !state.editor) return false;
    const current = guard(), editor = state.editor; lock(true);
    try {
      if (seedDefaults && state.peopleSeedEligible) for (const key of ["reviewers", "consultation"]) {
        if (state.peopleDefaults?.[key]?.version === 1) queuePeople(key);
      }
      if (!await flushPeopleDefaults() || !current() || editor !== state.editor) return false;
      if (!state.dirty && editor.version) return true;
      const saved = await request("save", { workspace_id: state.workspace, id: editor.id, version: editor.version, status: editor.status, fields: editor.fields });
      if (!current() || editor !== state.editor) return false;
      state.editor = saved; state.dirty = false; changed();
      if (!(await load())) return false;
      renderEditor(); notice("Saved. Save the project to include this SWMS in its project file."); return true;
    } finally { if (current()) lock(false); }
  }
  async function download() {
    if (!(await save())) return;
    const current = guard(), editor = state.editor;
    editor.pendingIssue ||= crypto.randomUUID(); lock(true);
    try {
      const result = await window.CeasefireDownloads.save("/api/swms/issue", { workspace_id: state.workspace, id: editor.id, version: editor.version, request_id: editor.pendingIssue }, { button: root().querySelector(".swms-download") });
      if (current() && editor === state.editor) {
        if (!result?.cancelled) editor.pendingIssue = null;
        notice(result?.cancelled ? "PDF download cancelled." : result?.saved ? "SWMS PDF saved." : "SWMS PDF prepared.");
      }
    } finally { if (current()) lock(false); }
  }
  async function chooseSignature() {
    const dialog = element("dialog", "modal swms-signature-dialog"), pad = element("canvas"), actions = element("div", "actions"), status = element("p", "muted");
    pad.width = 620; pad.height = 210; pad.setAttribute("aria-label", "SWMS signature drawing pad");
    dialog.append(element("h2", "", "Draw signature"), element("p", "", "Draw your signature below, then choose Use signature."), pad, status, actions);
    const ink = pad.getContext("2d"); let strokes = [], drawing = null, count = 0, result = null;
    function paint() { ink.fillStyle = "white"; ink.fillRect(0, 0, pad.width, pad.height); ink.strokeStyle = "#111"; ink.lineWidth = 2; ink.lineCap = "round"; strokes.forEach(stroke => { ink.beginPath(); stroke.forEach((point, index) => { if (!index) ink.moveTo(point[0] * pad.width, point[1] * pad.height); else ink.lineTo(point[0] * pad.width, point[1] * pad.height); }); ink.stroke(); }); }
    function point(event) { const box = pad.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))]; }
    pad.addEventListener("pointerdown", event => { if (strokes.length >= 100 || count >= 4000) { status.textContent = "Clear the pad and draw a simpler signature."; return; } drawing = [point(event)]; strokes.push(drawing); count++; pad.setPointerCapture(event.pointerId); paint(); });
    pad.addEventListener("pointermove", event => { if (drawing && count < 4000) { drawing.push(point(event)); count++; paint(); } });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(name => pad.addEventListener(name, () => { drawing = null; }));
    actions.append(button("Clear", () => { strokes = []; count = 0; status.textContent = ""; paint(); }), button("Cancel", () => dialog.close()), button("Use signature", () => {
      if (!strokes.some(stroke => stroke.length > 1)) { status.textContent = "Draw your signature first."; return; }
      result = { version: 1, ratio: pad.width / pad.height, strokes }; dialog.close();
    }, true));
    document.body.append(dialog); paint();
    try { dialog.showModal(); await new Promise(resolve => dialog.addEventListener("close", resolve, { once: true })); return result; }
    finally { dialog.remove(); }
  }
  function signature(value, update, label) {
    const host = element("div", "swms-signature");
    if (value) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${Math.round(value.ratio * 100)} 100`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label + " drawn signature");
      value.strokes.forEach(stroke => {
        const path = document.createElementNS(svg.namespaceURI, "polyline");
        path.setAttribute("points", stroke.map(point => `${point[0] * value.ratio * 100},${point[1] * 100}`).join(" "));
        path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5"); svg.append(path);
      }); host.append(svg);
    } else host.append(element("span", "muted", "Not signed"));
    host.append(button(value ? "Replace signature" : "Draw signature", async () => {
      if (state.busy) return;
      const current = guard(), editor = state.editor;
      const result = await chooseSignature();
      if (result && current() && editor === state.editor) { update(result); dirty(); host.replaceWith(signature(result, update, label)); }
    }));
    if (value) host.append(button("Clear signature", () => { update(null); dirty(); host.replaceWith(signature(null, update, label)); }));
    return host;
  }
  const detailLabels = { job_reference: "Job Reference", contact_person: "Contact Person", position: "Position", phone: "Phone", principal_contractor: "Principal Contractor (PC)", project_name: "Project Name", date: "Date", project_address: "Project Address", project_manager: "Project Manager (PM)", manager_contact: "Contact" };
  const labels = { communication: "Communication before work commences", toolbox: "Toolbox talks", compliance: "Person/s responsible for ensuring compliance with SWMS", qualifications: "Qualifications / Competency Required to complete tasks", duties: "Personnel / Duties and Responsibilities", training: "Additional training required to complete task", requirements: "Requirements", legislation: "OHS / Environmental Legislation", codes: "Codes of Practice", resources: "Resources / Trades Involved", equipment: "Equipment / Plant / Materials Used", maintenance: "Maintenance Checks Required", acknowledgement: "Employee acknowledgement", emergency_requirements: "Emergency Response — Call 000 Immediately", emergency_access: "Emergency access and site requirements", emergency_notify: "Notify", emergency_contacts: "Contacts", emergency_supervisor: "Notify site supervisor", emergency_call: "Call emergency services", emergency_stop: "Stop work", emergency_follow: "Follow instructions" };
  function textFields(host, fields, keys) { keys.forEach(key => host.append(field(labels[key], control(fields[key], value => { fields[key] = value; }, "textarea")))); }
  function people(host, key, heading) {
    const fields = state.editor.fields, box = section(heading), list = element("div", "swms-people");
    function render() {
      list.replaceChildren();
      fields[key].forEach((person, index) => {
        const row = element("div", "swms-person"), grid = element("div", "swms-grid");
        Object.keys(person).filter(name => name !== "signature").forEach(name => {
          const title = name[0].toUpperCase() + name.slice(1);
          const input = control(person[name], value => { person[name] = value; queuePeople(key); }, name === "date" ? "date" : name === "time" ? "time" : "text");
          grid.append(field(title, input));
        });
        row.append(grid, signature(person.signature, value => { person.signature = value; queuePeople(key); }, `${heading} ${index + 1}`));
        if (key === "signoffs" && person.latitude && person.longitude && Number.isFinite(Number(person.latitude)) && Number.isFinite(Number(person.longitude))) {
          const link = element("a", "button secondary", "View map"); link.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(person.latitude)}&mlon=${encodeURIComponent(person.longitude)}#map=17/${encodeURIComponent(person.latitude)}/${encodeURIComponent(person.longitude)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
        }
        row.append(button("Remove person", () => { fields[key].splice(index, 1); dirty(); queuePeople(key); render(); })); list.append(row);
      });
    }
    box.append(list, button("Add person", () => {
      if (fields[key].length >= 100) throw new Error("This section supports up to 100 people.");
      fields[key].push(key === "signoffs" ? { name: "", company: "", signature: null, date: "", time: "", latitude: "", longitude: "" } : key === "site_signoffs" ? { name: "", signature: null } : { name: "", position: "", signature: null }); dirty(); queuePeople(key); render();
    }));
    if (key === "signoffs") box.append(element("p", "muted", "Record sign-offs here using the signature pad. A location map opens only when you select View map."));
    render(); host.append(box);
  }
  const emptyStep = () => ({ job_step: "", hazards: "", initial_risk: "", controls: "", residual_risk: "", responsible: "" });
  function growStepInput(input) {
    if (!input.getClientRects().length) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  }
  function steps(host, title, rows, minimum = 1) {
    const box = section(title, true), scroll = element("div", "table-scroll"), table = element("table", "swms-step-table");
    const head = element("thead"), tr = element("tr"); ["Item", "Job Steps", "Hazards", "Risk Rating", "Controls to Eliminate / Reduce Hazard", "Retained Risk", "Responsible Person", "Actions"].forEach(text => tr.append(element("th", "", text))); head.append(tr);
    const body = element("tbody"); table.append(head, body); scroll.append(table);
    function render() {
      body.replaceChildren(); rows.forEach((row, index) => {
        const line = element("tr"); line.append(element("td", "", String(index + 1)));
        ["job_step", "hazards", "initial_risk", "controls", "residual_risk", "responsible"].forEach(key => {
          const cell = element("td"), label = `${title} item ${index + 1} ${key.replaceAll("_", " ")}`;
          const input = key.endsWith("risk") ? select(["", "1", "2", "3"], row[key], value => { row[key] = value; }) : control(row[key], value => { row[key] = value; }, "textarea");
          if (input.tagName === "TEXTAREA") { input.rows = 1; input.addEventListener("input", () => growStepInput(input)); }
          input.setAttribute("aria-label", label); input.maxLength = 12000; cell.append(input); line.append(cell);
        });
        const actions = element("td"), remove = button("Remove", () => { if (rows.length > minimum) { rows.splice(index, 1); dirty(); render(); } }); remove.disabled = rows.length <= minimum;
        actions.append(remove); line.append(actions); body.append(line);
      });
      requestAnimationFrame(() => body.querySelectorAll("textarea").forEach(growStepInput));
    }
    box.addEventListener("toggle", () => { if (box.open) body.querySelectorAll("textarea").forEach(growStepInput); });
    box.append(scroll, button("Add job step", () => { if (rows.length >= 200) throw new Error("A work type supports up to 200 steps."); rows.push(emptyStep()); dirty(); render(); })); render(); host.append(box);
  }
  function attachments(host, fields) {
    const box = section("Form Attachments"), list = element("div"), input = element("input"); input.type = "file"; input.multiple = true; input.accept = ".pdf,.png,.jpg,.jpeg";
    function render() {
      list.replaceChildren(); fields.attachments.forEach((file, index) => { const row = element("div", "swms-attachment"); row.append(element("span", "", file.name), button("Remove attachment", () => { fields.attachments.splice(index, 1); dirty(); render(); })); list.append(row); });
    }
    input.addEventListener("change", async () => {
      if (state.busy) return;
      const current = guard(), editor = state.editor;
      lock(true); notice("");
      try {
        const files = [...input.files];
        if (fields.attachments.length + files.length > 10) throw new Error("A SWMS supports up to ten attachments.");
        const added = [];
        for (const file of files) {
          if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type) || file.size > (file.type === "application/pdf" ? 10 : 2) * 1024 * 1024) throw new Error("Use PDF files up to 10 MB or PNG / JPEG images up to 2 MB.");
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("The attachment could not be read.")); reader.readAsDataURL(file); });
          added.push({ name: file.name, media_type: file.type, data });
        }
        if (current() && editor === state.editor) {
          const staged = { ...editor, fields: { ...fields, attachments: [...fields.attachments, ...added] } };
          const documents = [...(state.model?.documents || []).filter(row => row.id !== editor.id), staged];
          if (new TextEncoder().encode(JSON.stringify({documents})).length > 12 * 1024 * 1024 - 4096) throw new Error("These attachments exceed the project's 12 MiB SWMS storage budget after file encoding. Choose smaller files.");
          fields.attachments.push(...added); dirty(); render();
        }
      } catch (error) { if (current()) notice(error.message, true); }
      finally { input.value = ""; if (current()) lock(false); }
    });
    box.append(element("p", "muted", "PDF (up to 25 pages / 10 MB), PNG or JPEG (up to 2 MB). All SWMS documents and encoded attachments share a 12 MiB project storage budget. Attachments are included at the end of the PDF."), list, field("Add files", input)); render(); host.append(box);
  }
  function renderEditor() {
    const editor = state.editor, fields = editor.fields, host = shell("Safe Work Method Statement"), actions = element("div", "swms-toolbar");
    const downloadButton = button("Download PDF", download, true); downloadButton.classList.add("swms-download");
    const back = button("", async () => { await flushPeopleDefaults().catch(error => notice(error.message, true)); if (!state.busy && (!state.dirty || window.confirm("Discard unsaved SWMS edits?"))) renderList(); });
    back.classList.add("icon-only"); back.title = "Back to statements"; back.setAttribute("aria-label", "Back to statements");
    window.CeasefireI18n?.attr(back, "title", "Back to statements"); window.CeasefireI18n?.attr(back, "aria-label", "Back to statements");
    const arrow = element("span", "button-symbol", "←"); arrow.setAttribute("aria-hidden", "true"); back.append(arrow);
    actions.append(back, button("Save", () => save({seedDefaults:true}), true), downloadButton, element("span", "muted", editor.version ? `Revision ${editor.version}` : "New statement")); host.append(actions);
    const identity = element("div", "swms-grid"); identity.append(field("Document title", control(fields.title, value => { fields.title = value; })), field("Status", select(state.model?.statuses || ["Draft", "Review", "Approved", "Archived"], editor.status, value => { editor.status = value; }))); host.append(identity);
    const details = section("Project Details", true), grid = element("div", "swms-grid");
    Object.entries(detailLabels).forEach(([key, label]) => grid.append(field(label, control(fields.details[key], value => { fields.details[key] = value; }, key === "date" ? "date" : "text")))); details.append(grid, element("h3", "", "Project Manager Signature"), signature(fields.manager_signature, value => { fields.manager_signature = value; }, "Project manager")); host.append(details);
    const communication = section("Communication and responsibilities"); textFields(communication, fields, ["communication", "toolbox", "compliance"]); host.append(communication);
    people(host, "reviewers", "Person/s responsible for reviewing SWMS"); people(host, "consultation", "This SWMS has been developed in consultation with");
    const qualifications = section("Qualifications, duties and training"); textFields(qualifications, fields, ["qualifications", "duties", "training"]); host.append(qualifications);
    const requirements = section("Activity and work requirements"); requirements.append(field("Activity", select([...new Set([...(state.options?.activities || []), fields.activity])], fields.activity, value => { fields.activity = value; }))); textFields(requirements, fields, ["requirements", "legislation", "codes", "resources", "equipment", "maintenance"]); host.append(requirements);
    const risks = section("Risk Matrix and High Risk Work"), matrix = element("table", "swms-risk-matrix");
    const riskRows = [["Consequence / Probability", "Likely", "Moderate", "Unlikely"], ["High — death / permanent disability", "1", "1", "2"], ["Medium — temporary disability / minor structural failure", "1", "2", "3"], ["Low — first aid / minor environmental harm", "2", "3", "3"]];
    riskRows.forEach((row, index) => { const tr = element("tr"); row.forEach(value => { const cell = element(index ? "td" : "th", /^[123]$/.test(value) ? `swms-risk-${value}` : "", value); tr.append(cell); }); matrix.append(tr); });
    risks.append(matrix, element("p", "muted", "1 — High risk: action immediately. 2 — Medium risk: action as soon as practicable. 3 — Low risk: action as required."));
    const riskChecks = element("div", "swms-check-grid"), riskTables = element("div", "swms-high-risk-tables");
    fields.high_risk_steps ||= copy(state.options?.high_risk_tables || {});
    function renderRisks() {
      riskChecks.replaceChildren(); riskTables.replaceChildren();
      const selected = fields.high_risk_work.split("\n");
      (state.options?.high_risk || []).forEach(value => riskChecks.append(check(value, selected.includes(value), enabled => {
        const next = new Set(fields.high_risk_work.split("\n").filter(Boolean));
        if (enabled) { if (value === "NA") next.clear(); else next.delete("NA"); next.add(value); } else next.delete(value);
        fields.high_risk_work = [...next].join("\n"); renderRisks();
      })));
      selected.forEach(value => { if (fields.high_risk_steps[value]?.length) steps(riskTables, value, fields.high_risk_steps[value]); });
    }
    renderRisks(); risks.append(riskChecks, riskTables); risks.addEventListener("toggle", () => { if (risks.open) riskTables.querySelectorAll("textarea").forEach(growStepInput); }); host.append(risks);
    const work = section("Type of Works", true), checks = element("div", "swms-check-grid"), tables = element("div");
    function renderWorks() { tables.replaceChildren(); fields.work_types.forEach(kind => steps(tables, kind, fields.steps[kind])); }
    Object.keys(fields.steps).forEach(kind => checks.append(check(kind, fields.work_types.includes(kind), enabled => { if (!enabled && fields.work_types.length === 1) { notice("Choose at least one type of works.", true); checks.querySelectorAll("input").forEach((item, index) => { item.checked = fields.work_types.includes(Object.keys(fields.steps)[index]); }); return; } fields.work_types = enabled ? [...fields.work_types, kind] : fields.work_types.filter(value => value !== kind); renderWorks(); })));
    work.append(checks, tables); renderWorks(); host.append(work);
    const additional = section("Additional Job Steps"), extra = element("div");
    function renderExtra() { extra.replaceChildren(); if (fields.additional_steps) steps(extra, "Additional Job Steps", fields.additional_rows, 0); }
    additional.append(field("Are there additional job steps to consider?", select(["No", "Yes"], fields.additional_steps ? "Yes" : "No", value => { fields.additional_steps = value === "Yes"; renderExtra(); })), extra); renderExtra(); host.append(additional);
    const acknowledgment = section("Employee acknowledgement"); textFields(acknowledgment, fields, ["acknowledgement"]); host.append(acknowledgment);
    const reviews = section("Reviews"), reviewGrid = element("div", "swms-review-grid"); fields.reviews.forEach((value, index) => reviewGrid.append(field(`Review ${index + 1} initials`, control(value, text => { fields.reviews[index] = text; })))); reviews.append(reviewGrid); host.append(reviews);
    people(host, "site_signoffs", "Site Sign-Off"); const emergency = section("Emergency Response"); textFields(emergency, fields, ["emergency_requirements", "emergency_access", "emergency_notify", "emergency_contacts", "emergency_supervisor", "emergency_call", "emergency_stop", "emergency_follow"]); host.append(emergency); attachments(host, fields);
  }
  window.CeasefireSWMS = {
    activate,
    async completeProjectSnapshot() {
      if (state.busy || state.dirty || peoplePending()) throw new Error("Save or discard SWMS edits before saving the project.");
      if (!workspace()) return null;
      const captured = workspace(), capturedContext = context();
      const result = await request(`state?workspace=${encodeURIComponent(captured)}`);
      if (captured !== workspace() || capturedContext !== context()) throw new Error("The project changed while saving SWMS documents.");
      return result.snapshot;
    },
    async prepareProject(value, workspace_id) { return { value: copy(value || null), workspace_id }; },
    applyProject(prepared) {
      clearTimeout(state.peopleTimer); state.peopleTimer = null; state.peopleDesired = {}; state.peopleDefaults = null; state.peopleError = null;
      state.workspace = prepared?.workspace_id || null; state.model = null; state.editor = null; state.options = null;
      state.dirty = false; state.changed = false; state.busy = false; state.revision++;
    },
    projectFingerprint() { return JSON.stringify({ workspace: state.workspace, snapshot: state.model?.snapshot, editor: state.editor, dirty: state.dirty, peopleDesired: state.peopleDesired, peopleError: state.peopleError?.message }); },
    hasPendingOperation() { return state.busy || state.dirty || peoplePending(); },
    hasProjectChanges() { return state.changed || state.dirty || peoplePending(); },
    markProjectSaved(saved, captured) { if (!captured || JSON.stringify(state.model?.snapshot) === JSON.stringify(captured)) state.changed = false; }
  };
})();
