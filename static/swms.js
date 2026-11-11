(() => {
  "use strict";
  const state = { workspace: null, model: null, editor: null, options: null, busy: false, dirty: false, changed: false, revision: 0, search: "" };
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
    }
  }
  function changed() { state.changed = true; window.CeasefireProject?.changed?.(); }
  function dirty() { state.dirty = true; if (state.editor) state.editor.pendingIssue = null; window.CeasefireProject?.changed?.(); if (state.editor) updateRequiredFields(); }
  function requirementControl(path) { return [...root().querySelectorAll('[data-swms-required-path]')].find(input => input.dataset.swmsRequiredPath === path); }
  const meaningful = value => typeof value === 'string' && value.replace(/\p{Cf}/gu, '').trim().length > 0;
  const signed = value => Boolean(value?.strokes?.some(stroke => stroke.some(point => point[0] !== stroke[0][0] || point[1] !== stroke[0][1])));
  function requirementPresent(spec) {
    const fields = state.editor.fields, value = spec.path.split('.').reduce((object, key) => object?.[key], fields);
    if (spec.type === 'people') return value.length > 0 && value.every(person => meaningful(person.name) && meaningful(person.position) && signed(person.signature));
    if (spec.type === 'high-risk') { const selected = value.split('\n'); return selected.length > 0 && selected.every(choice => state.options.high_risk.includes(choice)) && (!selected.includes('NA') || selected.length === 1); }
    if (spec.type === 'works') return value.length > 0 || fields.additional_steps && fields.additional_rows.some(row => meaningful(row.job_step));
    return meaningful(value);
  }
  function required(path, input) { input.dataset.swmsRequiredPath = path; return input; }
  function updateRequiredFields() {
    for (const spec of state.model?.requirements || []) {
      const input = requirementControl(spec.path); if (!input) continue;
      input.setAttribute('aria-required', 'true');
      const label = input.closest('.field')?.querySelector(':scope > span') || input.querySelector(':scope > summary');
      label?.classList.add('swms-required-label');
      if (requirementPresent(spec)) input.removeAttribute('aria-invalid');
    }
  }
  function validateReadiness() {
    const missing = (state.model?.requirements || []).filter(spec => !requirementPresent(spec));
    if (!missing.length) return;
    for (const spec of missing) {
      const input = requirementControl(spec.path); if (!input) continue;
      input.setAttribute('aria-invalid', 'true');
      for (let node = input; node && node !== root(); node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    }
    const first = requirementControl(missing[0].path);
    (first?.matches('input,textarea,select') ? first : first?.querySelector('button,input,textarea,select'))?.focus();
    const labels = missing.map(spec => window.CeasefireI18n?.translate(spec.label) || spec.label).join(', ');
    throw new Error(window.CeasefireI18n?.translate('Complete required SWMS fields: {0}.', [labels]) || `Complete required SWMS fields: ${labels}.`);
  }
  function button(label, action, primary = false) {
    const result = element("button", `button ${primary ? "primary" : "secondary"}`, label);
    result.type = "button";
    result.addEventListener("click", () => Promise.resolve(action()).catch(error => notice(error.message, true)));
    return result;
  }
  function iconAction(label, action, kind) {
    const result = button("", action, kind === "add");
    result.classList.add("icon-only"); result.title = label; result.setAttribute("aria-label", label);
    window.CeasefireI18n?.attr(result, "title", label); window.CeasefireI18n?.attr(result, "aria-label", label);
    if (kind !== "add") result.classList.add("swms-icon-action");
    if (kind === "signature") {
      result.classList.add("takeoff-icon-button", "takeoff-signature-button", "personal-signature-button");
      const symbol = element("span", "takeoff-action-icon takeoff-signature-icon"); symbol.setAttribute("aria-hidden", "true"); result.append(symbol);
    } else if (kind === "clear") {
      const icon = document.querySelector("#penetration-clear svg").cloneNode(true);
      icon.setAttribute("aria-hidden", "true"); result.append(icon);
    } else if (kind === "add") {
      result.classList.add("penetration-new-item-action");
      const symbol = element("span", "button-symbol add-symbol", "+"); symbol.setAttribute("aria-hidden", "true"); result.append(symbol);
    } else {
      // Reuse the application's existing trash-can artwork.
      result.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"></path></svg>';
    }
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
    const persistentTitle = document.getElementById("swms-heading");
    if (persistentTitle) window.CeasefireI18n?.text(persistentTitle, title);
    else {
      const heading = element("div", "page-heading"), titleNode = element("h1", "", title);
      window.CeasefireI18n?.text(titleNode, title); heading.append(titleNode); host.append(heading);
    }
    const message = element("p", "swms-message message"); message.setAttribute("role", "status"); message.hidden = true;
    host.append(message); return host;
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
    shell("SWMS");
    try {
      const identity = workspace() || (await window.CeasefireCertification.projectWorkspace()).workspace_id;
      if (revision !== state.revision || capturedContext !== context() || identity !== workspace()) return;
      state.workspace = identity;
      if (await load()) renderList();
    } catch (error) { if (revision === state.revision) notice(error.message, true); }
  }
  let leavingEditor = false;
  async function leaveEditor() {
    if (leavingEditor) return false;
    if (state.busy) {
      window.CeasefireDialogs.message("Finish the current SWMS operation before changing views.", true);
      return false;
    }
    const editor = state.editor, current = guard();
    leavingEditor = true;
    try {
      if (state.dirty) {
        const discard = await window.CeasefireDialogs.confirm("Discard the current SWMS?", "", "Yes", "Cancel");
        if (!current() || state.editor !== editor) return false;
        if (!discard) {
          window.CeasefireDialogs.message("Save or discard the current SWMS edit before changing views.", true);
          return false;
        }
      }
      if (!current() || state.editor !== editor || state.busy) return false;
      renderList();
      window.CeasefireProject?.changed?.();
      return true;
    } catch (error) {
      notice(error.message, true);
      return false;
    } finally {
      leavingEditor = false;
    }
  }
  function renderList() {
    state.editor = null; state.dirty = false;
    const host = shell("SWMS"), bar = element("div", "swms-toolbar");
    const search = element("input"); search.type = "search"; search.value = state.search;
    search.placeholder = "Title, project or site address…";
    search.addEventListener("input", () => { state.search = search.value; cards(); });
    const create=iconAction('New SWMS',openNew,'add');create.classList.add('add-icon-action');
    const access=window.ClassifireAccess;
    if(access){create.disabled=true;void access.ready.then(()=>{if(create.isConnected)create.disabled=state.busy || !access.can('edit');});}
    bar.append(field("Search statements", search), create); host.append(bar, element("div", "swms-list")); cards();
  }
  function cardHeading(row) {
    const details = row.fields.details, project = window.CeasefireProject?.details?.() || {};
    const place = [details.project_name || project.client, details.project_address || project.site_address].filter(Boolean).join(' - ');
    return [row.reference || 'SWMS', place].filter(Boolean).join(': ');
  }
  function statementCard(row) {
    const card = element('article', 'project-kanban-card swms-card'), heading = element('h3'), actions = element('div', 'actions');
    const title = button(cardHeading(row), () => open(row));
    title.className = 'text-button project-title-button'; heading.append(title);
    actions.append(iconAction('Delete', () => remove(row), 'remove'));
    card.append(heading, element('p', 'muted', `Revision ${row.version} · Updated ${new Date(row.updated_at).toLocaleString('en-AU')}`), actions);
    return card;
  }
  async function moveStatement(row, status) {
    if (state.busy || state.editor) return;
    const current = guard(); lock(true);
    try {
      await request('save', {workspace_id:state.workspace, id:row.id, version:row.version, fields:row.fields, status});
      if (current()) {changed(); if (await load()) renderList();}
    } catch (error) {
      if (current()) {if (error.status === 409 && await load()) renderList(); notice(error.message, true);}
    } finally {if (current()) lock(false);}
  }
  function cards() {
    const needle = state.search.toLowerCase();
    const rows = (state.model?.documents || []).filter(row =>
      [cardHeading(row), row.fields.title, ...Object.values(row.fields.details)].join(' ').toLowerCase().includes(needle)
    ).sort((a,b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    window.ClassifireDocumentBoard.render(root().querySelector('.swms-list'), {
      items:rows, stageOf:row => row.status, legacy:['Archived'], cardFor:statementCard,
      move:moveStatement, onError:error=>notice(error.message,true), locked:() => state.busy || Boolean(state.editor)
    });
  }
  async function defaults() {
    const details = window.CeasefireProject?.details?.() || {};
    return request("defaults", { workspace_id: state.workspace, details: { project_no: details.project_no || "", client: details.client || "", site_address: details.site_address || "" } });
  }
  async function openNew() {
    if (state.busy) return;
    if (!window.CeasefireProject?.requireCreatedProject?.()) return;
    const current = guard(); lock(true);
    try {
      const result = await defaults(); if (!current()) return;
      state.options = result.options; state.editor = { id: crypto.randomUUID(), version: 0, status: "Draft", fields: result.fields };
      state.dirty = true; renderEditor(); window.CeasefireProject?.changed?.();
    } finally { if (current()) lock(false); }
  }
  async function open(row) {
    if (state.busy) return;
    const current = guard(); lock(true);
    try {
      const result = await defaults(); if (!current()) return; state.options = result.options;
      state.editor = copy(row); state.dirty = false; renderEditor();
    } finally { if (current()) lock(false); }
  }
  async function remove(row) {
    if (state.busy || !window.confirm(`Delete “${cardHeading(row)}” from this project?`)) return;
    const current = guard(); lock(true);
    try { await request("delete", { workspace_id: state.workspace, id: row.id, version: row.version }); if (!current()) return; changed(); if (await load()) renderList(); }
    finally { if (current()) lock(false); }
  }
  async function save() {
    if (state.busy || !state.editor) return false;
    const current = guard(), editor = state.editor; lock(true);
    try {
      if (!current() || editor !== state.editor) return false;
      if (!state.dirty && editor.version) return true;
      const saved = await request("save", { workspace_id: state.workspace, id: editor.id, version: editor.version, status: editor.status, fields: editor.fields });
      if (!current() || editor !== state.editor) return false;
      state.editor = saved; state.dirty = false; changed();
      if (!(await load())) return false;
      renderEditor(); notice("Saved. Save the project to include this SWMS in its project file."); return true;
    } finally { if (current()) lock(false); }
  }
  async function download() {
    if (state.busy || !state.editor) return;
    validateReadiness();
    if (!(await save())) return;
    const current = guard(), editor = state.editor;
    editor.pendingIssue ||= crypto.randomUUID(); lock(true);
    try {
      const result = await window.CeasefireDownloads.save("/api/swms/issue", { workspace_id: state.workspace, id: editor.id, version: editor.version, request_id: editor.pendingIssue }, { button: root().querySelector(".swms-download") });
      if (current() && editor === state.editor) {
        if (!result?.cancelled && await load() && current() && editor === state.editor) {
          const saved = state.model.documents.find(row => row.id === editor.id);
          if (saved) { state.editor = copy(saved); state.editor.pendingIssue = null; changed(); renderEditor(); }
        }
        notice(result?.cancelled ? "PDF download cancelled." : result?.saved ? "SWMS PDF saved." : "SWMS PDF prepared.");
      }
    } finally { if (current()) lock(false); }
  }
  async function signatureProfile() {
    const response=await fetch('/api/scheduler/bootstrap',{cache:'no-store'}), saved=await response.json();
    if(!response.ok || !saved || !Object.hasOwn(saved,'user') || saved.user !== null && typeof saved.user?.id !== 'string') throw new Error('Personal details could not be loaded. Try again.');
    return saved.user?.id || null;
  }
  async function personalDetails(withCompanyPhone = false) {
    const response=await fetch('/api/certifications/defaults',{cache:'no-store'});
    const saved=await response.json();
    if(!response.ok || !saved?.fields || ['name','position','qualification','accreditation'].some(key=>typeof saved.fields[key]!=='string')) throw new Error('Personal details could not be loaded. Try again.');
    if(!withCompanyPhone)return saved.fields;
    const companyResponse=await fetch('/api/company-settings',{cache:'no-store'}), company=await companyResponse.json();
    if(!companyResponse.ok || typeof company.phone !== 'string')throw new Error('Company details could not be loaded. Try again.');
    return {...saved.fields,phone:company.phone};
  }
  function signature(value, update, label, removePerson, onSigned, options = {}) {
    const host = element("div", "swms-signature"), actions = element("div", "swms-signature-actions");
    const currentOwner = guard(), owner = state.editor;
    const attached = () => currentOwner() && owner === state.editor && host.isConnected;
    if(options.contact)host.classList.add('swms-contact-signature');
    if (value) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${Math.round(value.ratio * 100)} 100`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label + " drawn signature");
      if(options.contact)window.CeasefireI18n?.attr(svg, 'aria-label', 'Contact person drawn signature');
      value.strokes.forEach(stroke => {
        const path = document.createElementNS(svg.namespaceURI, "polyline");
        path.setAttribute("points", stroke.map(point => `${point[0] * value.ratio * 100},${point[1] * 100}`).join(" "));
        path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5"); svg.append(path);
      }); host.append(svg);
    } else host.append(element("span", "muted", "Not signed"));
    function setSignature(next) {
      if (!attached()) return;
      if(next === null && options.clear?.() === false)return;
      update(next);
      dirty();
      const replacement = signature(next, update, label, removePerson, onSigned, options);
      host.replaceWith(replacement);
      replacement.querySelector("button").focus({preventScroll:true});
    }
    actions.append(iconAction(value ? "Replace signature" : "Draw signature", async () => {
      if (state.busy) return;
      const current = guard(), editor = state.editor;
      lock(true);
      try {
        const profile=await signatureProfile();
        if(!current() || editor !== state.editor)return;
        const result = await window.ClassifirePersonalSignature.choose(value, "swms");
        if (!result || !current() || editor !== state.editor) return;
        const saved=await personalDetails(options.contact), after=await signatureProfile();
        if(profile !== after)throw new Error('Your signature profile changed. Reopen the signature pad.');
        if (!current() || editor !== state.editor || !attached() || onSigned?.(saved) === false) return;
        setSignature(result); notice("");
      } catch(error) { if(current() && editor === state.editor)throw error; }
      finally { if(current() && editor === state.editor)lock(false); }
    }, "signature"));
    if (value) actions.append(iconAction("Clear signature", () => {if(!state.busy)setSignature(null);}, "clear"));
    if (removePerson) actions.append(iconAction("Remove person", removePerson, "remove"));
    host.append(actions);
    return host;
  }
  const detailLabels = { job_reference: "Job Reference", contact_person: "Contact Person", position: "Position", phone: "Phone", principal_contractor: "Principal Contractor (PC)", project_name: "Project Name", date: "Date", project_address: "Project Address", project_manager: "Project Manager (PM)", manager_contact: "Contact" };
  const labels = { communication: "Communication before work commences", toolbox: "Toolbox talks", compliance: "Person/s responsible for ensuring compliance with SWMS", qualifications: "Qualifications / Competency Required to complete tasks", duties: "Personnel / Duties and Responsibilities", training: "Additional training required to complete task", requirements: "Requirements", legislation: "OHS / Environmental Legislation", codes: "Codes of Practice", resources: "Resources / Trades Involved", equipment: "Equipment / Plant / Materials Used", maintenance: "Maintenance Checks Required", acknowledgement: "Employee acknowledgement", emergency_requirements: "Emergency Response — Call 000 Immediately", emergency_access: "Emergency access and site requirements", emergency_notify: "Notify", emergency_contacts: "Contacts", emergency_supervisor: "Notify site supervisor", emergency_call: "Call emergency services", emergency_stop: "Stop work", emergency_follow: "Follow instructions" };
  function textFields(host, fields, keys) { keys.forEach(key => host.append(field(labels[key], required(key, control(fields[key], value => { fields[key] = value; }, "textarea"))))); }
  function people(host, key, heading) {
    const fields = state.editor.fields, box = required(key, section(heading)), list = element("div", "swms-people");
    function render() {
      list.replaceChildren();
      fields[key].forEach((person, index) => {
        const row = element("div", "swms-person"), grid = element("div", "swms-grid"), inputs = {};
        Object.keys(person).filter(name => name !== "signature").forEach(name => {
          const title = name[0].toUpperCase() + name.slice(1);
          const input = control(person[name], value => { person[name] = value; }, name === "date" ? "date" : name === "time" ? "time" : "text");
          if (key === 'reviewers' || key === 'consultation') input.setAttribute('aria-required', 'true');
          inputs[name]=input;grid.append(field(title, input));
        });
        const removePerson = () => { fields[key].splice(index, 1); dirty(); render(); };
        row.append(grid, signature(person.signature, value => { person.signature = value; }, `${heading} ${index + 1}`, removePerson, saved=>{
          if(!fields[key].includes(person))return false;
          for(const name of ['name','position'])if(inputs[name] && !person[name].trim()) { person[name]=saved[name];inputs[name].value=saved[name]; }
          return true;
        },{clear:()=>{
          if(!fields[key].includes(person))return false;
          for(const name of ['name','position'])if(inputs[name]){person[name]='';inputs[name].value='';}
          return true;
        }}));
        if (key === "signoffs" && person.latitude && person.longitude && Number.isFinite(Number(person.latitude)) && Number.isFinite(Number(person.longitude))) {
          const link = element("a", "button secondary", "View map"); link.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(person.latitude)}&mlon=${encodeURIComponent(person.longitude)}#map=17/${encodeURIComponent(person.latitude)}/${encodeURIComponent(person.longitude)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
        }
        list.append(row);
      });
    }
    box.append(list, iconAction("Add person", () => {
      if (fields[key].length >= 100) throw new Error("This section supports up to 100 people.");
      fields[key].push(key === "signoffs" ? { name: "", company: "", signature: null, date: "", time: "", latitude: "", longitude: "" } : key === "site_signoffs" ? { name: "", signature: null } : { name: "", position: "", signature: null }); dirty(); render();
    }, "add"));
    if (key === "signoffs") box.append(element("p", "muted", "Record sign-offs here using the signature pad. A location map opens only when you select View map."));
    render(); host.append(box);
  }
  const emptyStep = () => ({ job_step: "", hazards: "", initial_risk: "", controls: "", residual_risk: "", responsible: "" });
  function sizeStepRows(rows) {
    const groups = [];
    for (const row of rows) {
      if (row.closest("details:not([open])") || !row.getClientRects().length) continue;
      groups.push([...row.querySelectorAll(".swms-step-narrative")], [row.querySelector(".swms-step-responsible")]);
    }
    // Reset in one pass so a shortened field can also shrink the whole row.
    for (const group of groups) for (const input of group) input.style.height = "auto";
    const heights = groups.map(group => Math.max(...group.map(input => input.scrollHeight + input.offsetHeight - input.clientHeight)));
    groups.forEach((group, index) => {
      for (const input of group) input.style.height = `${heights[index]}px`;
    });
  }
  let stepLayoutFrame = 0;
  function scheduleStepLayout() {
    if (stepLayoutFrame) return;
    stepLayoutFrame = requestAnimationFrame(() => {
      stepLayoutFrame = 0;
      sizeStepRows(root().querySelectorAll(".swms-step-table tbody > tr"));
    });
  }
  const swmsRoot = root();
  if (swmsRoot) {
    let previousWidth = 0;
    new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== previousWidth) {
        previousWidth = entry.contentRect.width;
        scheduleStepLayout();
      }
    }).observe(swmsRoot);
    swmsRoot.addEventListener("toggle", event => { if (event.target.open) scheduleStepLayout(); }, true);
    document.fonts.ready.then(scheduleStepLayout);
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
          if (input.tagName === "TEXTAREA") {
            input.rows = 1;
            input.classList.add(key === "responsible" ? "swms-step-responsible" : "swms-step-narrative");
            input.addEventListener("input", () => sizeStepRows([line]));
          }
          input.setAttribute("aria-label", label); input.maxLength = 12000; cell.append(input); line.append(cell);
        });
        const actions = element("td"), remove = iconAction("Remove", () => { if (rows.length > minimum) { rows.splice(index, 1); dirty(); render(); } }, "remove"); remove.disabled = rows.length <= minimum;
        actions.append(remove); line.append(actions); body.append(line);
      });
      scheduleStepLayout();
    }
    box.append(scroll, iconAction("Add job step", () => { if (rows.length >= 200) throw new Error("A work type supports up to 200 steps."); rows.push(emptyStep()); dirty(); render(); }, "add")); render(); host.append(box);
  }
  function attachments(host, fields) {
    const box = section("Form Attachments"), list = element("div"), input = element("input"); input.type = "file"; input.multiple = true; input.accept = ".pdf,.png,.jpg,.jpeg";
    function render() {
      list.replaceChildren(); fields.attachments.forEach((file, index) => { const row = element("div", "swms-attachment"); row.append(element("span", "", file.name), iconAction("Remove attachment", () => { fields.attachments.splice(index, 1); dirty(); render(); }, "remove")); list.append(row); });
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
    const back = button("", leaveEditor);
    back.classList.add("icon-only", "swms-back-action"); back.title = "Back to statements"; back.setAttribute("aria-label", "Back to statements");
    window.CeasefireI18n?.attr(back, "title", "Back to statements"); window.CeasefireI18n?.attr(back, "aria-label", "Back to statements");
    const backIcon = element("span", "button-symbol", "←"); backIcon.setAttribute("aria-hidden", "true"); back.append(backIcon);
    actions.append(back, button("Save", () => save(), true), downloadButton, element("span", "muted", editor.version ? `Revision ${editor.version}` : "New statement")); host.append(actions);
    const stages = [...window.ClassifireDocumentBoard.stages];
    if (editor.status === 'Archived') stages.push('Archived');
    const identity = element('div', 'swms-grid swms-identity');
    const stageInput = select(stages, editor.status, value => { editor.status = value; });
    const stageField = field('Workflow status', stageInput);
    window.CeasefireI18n?.text(stageField.firstChild, 'Workflow status');
    window.CeasefireI18n?.attr(stageInput, 'aria-label', 'Workflow status');
    for (const option of stageInput.options) window.CeasefireI18n?.text(option, option.value);
    identity.append(stageField); host.append(identity);
    const details = section("Project Details", true), grid = element("div", "swms-grid"), detailInputs = {};
    for (const [key, label] of Object.entries(detailLabels)) {
      const input=required('details.' + key, control(fields.details[key], value => { fields.details[key] = value; }, key === "date" ? "date" : "text"));
      if(key === 'job_reference')input.readOnly=true;
      detailInputs[key]=input;
      const item=field(label,input);
      if(key === 'contact_person') {
        item.classList.add('swms-contact-field');
        const entry=element('div','swms-contact-entry');input.replaceWith(entry);
        const fill=values=>{for(const name of ['contact_person','position','phone']){fields.details[name]=values[name];detailInputs[name].value=values[name];}};
        entry.append(input,signature(fields.contact_signature || null,value=>{fields.contact_signature=value;},'Contact person',null,saved=>{
          fill({contact_person:saved.name,position:saved.position,phone:saved.phone});
        },{contact:true,clear:()=>fill({contact_person:'',position:'',phone:''})}));
      }
      grid.append(item);
      if (key === "job_reference") {
        const ref = element("input"); ref.readOnly = true; ref.value = editor.reference || ""; ref.placeholder = "Assigned on first save";
        grid.append(field("SWMS Reference", ref));
      }
    }
    details.append(grid, element("h3", "", "Project Manager Signature"), signature(fields.manager_signature, value => { fields.manager_signature = value; }, "Project manager", null, saved=>{
      if(!fields.details.project_manager.trim()){fields.details.project_manager=saved.name;detailInputs.project_manager.value=saved.name;}
    },{clear:()=>{fields.details.project_manager='';detailInputs.project_manager.value='';}})); host.append(details);
    const communication = section("Communication and responsibilities"); textFields(communication, fields, ["communication", "toolbox", "compliance"]); host.append(communication);
    people(host, "reviewers", "Person/s responsible for reviewing SWMS"); people(host, "consultation", "This SWMS has been developed in consultation with");
    const qualifications = section("Qualifications, duties and training"); textFields(qualifications, fields, ["qualifications", "duties", "training"]); host.append(qualifications);
    const requirements = section("Activity and work requirements"); requirements.append(field("Activity", required('activity', select([...new Set([...(state.options?.activities || []), fields.activity])], fields.activity, value => { fields.activity = value; })))); textFields(requirements, fields, ["requirements", "legislation", "codes", "resources", "equipment", "maintenance"]); host.append(requirements);
    const risks = required('high_risk_work', section("Risk Matrix and High Risk Work")), matrix = element("table", "swms-risk-matrix");
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
    renderRisks(); risks.append(riskChecks, riskTables); host.append(risks);
    const work = required('work_types', section("Type of Works", true)), checks = element("div", "swms-check-grid"), tables = element("div");
    function renderWorks() { tables.replaceChildren(); fields.work_types.forEach(kind => steps(tables, kind, fields.steps[kind])); }
    Object.keys(fields.steps).forEach(kind => checks.append(check(kind, fields.work_types.includes(kind), enabled => { fields.work_types = enabled ? [...fields.work_types, kind] : fields.work_types.filter(value => value !== kind); renderWorks(); })));
    work.append(checks, tables); renderWorks(); host.append(work);
    const additional = section("Additional Job Steps"), extra = element("div");
    function renderExtra() { extra.replaceChildren(); if (fields.additional_steps) steps(extra, "Additional Job Steps", fields.additional_rows, 0); }
    additional.append(field("Are there additional job steps to consider?", select(["No", "Yes"], fields.additional_steps ? "Yes" : "No", value => { fields.additional_steps = value === "Yes"; renderExtra(); })), extra); renderExtra(); host.append(additional);
    const acknowledgment = section("Employee acknowledgement"); textFields(acknowledgment, fields, ["acknowledgement"]); host.append(acknowledgment);
    const reviews = section("Reviews"), reviewGrid = element("div", "swms-review-grid"); fields.reviews.forEach((value, index) => reviewGrid.append(field(`Review ${index + 1} initials`, control(value, text => { fields.reviews[index] = text; })))); reviews.append(reviewGrid); host.append(reviews);
    people(host, "site_signoffs", "Site Sign-Off"); const emergency = section("Emergency Response"); textFields(emergency, fields, ["emergency_requirements", "emergency_access", "emergency_notify", "emergency_contacts", "emergency_supervisor", "emergency_call", "emergency_stop", "emergency_follow"]); host.append(emergency); attachments(host, fields);
    updateRequiredFields();
  }
  window.CeasefireSWMS = {
    activate,
    leaveEditor,
    async openFromEstimate() {
      if (!state.workspace || state.workspace !== workspace() || !state.model || state.dirty || state.busy) return;
      try { await openNew(); } catch (error) { notice(error.message, true); }
    },
    async completeProjectSnapshot() {
      if (state.busy || state.dirty) throw new Error("Save or discard SWMS edits before saving the project.");
      if (!workspace()) return null;
      const captured = workspace(), capturedContext = context();
      const result = await request(`state?workspace=${encodeURIComponent(captured)}`);
      if (captured !== workspace() || capturedContext !== context()) throw new Error("The project changed while saving SWMS documents.");
      return result.snapshot;
    },
    async prepareProject(value, workspace_id) { return { value: copy(value || null), workspace_id }; },
    applyProject(prepared) {
      state.workspace = prepared?.workspace_id || null; state.model = null; state.editor = null; state.options = null;
      state.dirty = false; state.changed = false; state.busy = false; state.revision++;
    },
    projectFingerprint() { return JSON.stringify({ workspace: state.workspace, snapshot: state.model?.snapshot, editor: state.editor, dirty: state.dirty }); },
    hasPendingOperation() { return state.busy || state.dirty; },
    hasProjectChanges() { return state.changed || state.dirty; },
    markProjectSaved(saved, captured) { if (!captured || JSON.stringify(state.model?.snapshot) === JSON.stringify(captured)) state.changed = false; }
  };
})();
