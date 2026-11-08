(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const pane = $("project-details-pane");
  if (!pane) return;
  const translate = source => window.CeasefireI18n?.translate?.(source) || source;
  const text = (element,source) => window.CeasefireI18n ? window.CeasefireI18n.text(element,source) : (element.textContent=source);
  const fields = {project_no:"project-pane-number", client:"project-pane-client", site_address:"project-pane-address", contact_name:"project-pane-contact-name", contact_phone:"project-pane-contact-phone", contact_email:"project-pane-contact-email"};
  const normalize = details => Object.fromEntries([...Object.keys(fields), "account_id"].map(key => [key, String(details?.[key] || "").trim()]));
  const stamp = details => JSON.stringify(normalize(details));
  const sharedStamp = details => { const value = normalize(details); delete value.project_no; return JSON.stringify(value); };
  const snapshot = () => window.CeasefireProject.projectPaneSnapshot();
  let selected = null, ticket = 0, pending = false, accounts = [], accountId = "", accountName = "", optionIndex = -1, options = [], directoryTicket = 0, currentRule = null;
  function details() { return {...Object.fromEntries(Object.entries(fields).map(([key,id]) => [key,$(id).value.trim()])), account_id:accountId}; }
  function dirty() { return !!selected && selected.kind === "saved" && stamp(details()) !== stamp(selected.baseline); }
  function notice(value = "", error = false) {
    text($("project-details-status"), value);
    $("project-details-status").classList.toggle("error", error);
  }
  function busy(value) {
    pending = value; pane.setAttribute("aria-busy", String(value));
    for (const control of pane.querySelectorAll("input,button")) control.disabled = value || !!selected?.blocked && control.id !== "project-details-close";
    $("project-current-details").disabled = value;
  }
  function refreshToggles() {
    for (const button of document.querySelectorAll("[data-project-details-id]")) {
      const expanded = !pane.hidden && selected?.kind === "saved" && selected.file.id === button.dataset.projectDetailsId;
      button.textContent = expanded ? ">" : "<";
      button.setAttribute("aria-expanded", String(expanded));
    }
  }
  function dismissOptions() {
    $("project-account-options").hidden = true;
    $("project-pane-client").setAttribute("aria-expanded", "false");
    $("project-pane-client").removeAttribute("aria-activedescendant");
    optionIndex = -1;
  }
  function hide() {
    ++ticket; selected = null; pane.hidden = true;
    busy(false);
    $("project-workspace-layout").classList.remove("project-pane-open");
    dismissOptions(); refreshToggles();
  }
  async function leave() {
    if (pending) { notice("Finish the current project details action first.", true); return false; }
    if (dirty() && !await window.CeasefireDialogs.confirm(translate("Discard unsaved project details?"), translate("The changes in this Project Details pane have not been saved. Discard them?"), translate("Yes"), translate("Cancel"))) return false;
    hide(); return true;
  }
  function show(values, target) {
    for (const [key,id] of Object.entries(fields)) $(id).value = values[key] || "";
    accountId = values.account_id || ""; accountName = values.client || "";
    $("project-details-target").textContent = target;
    $("project-details-save").hidden = selected.kind === "current";
    pane.hidden = false; $("project-workspace-layout").classList.add("project-pane-open");
    notice(selected.kind === "current" ? "Use the main Save button to save this project's details and estimate." : "");
    dismissOptions(); refreshToggles();
  }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? undefined : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Project details could not be updated.");
    return value;
  }
  async function open(file) {
    if (snapshot().busy || !await leave()) return;
    const generation = ++ticket;
    selected = {kind:"saved",file,baseline:normalize({})};
    show({}, file.title || file.name || translate("Project")); busy(true); notice("Loading project details…");
    try {
      const result = await request("/api/projects/details", {id:file.id});
      if (generation !== ticket) return;
      const active = snapshot();
      if (active.file?.path === result.file?.path && active.file.revision !== result.revision) throw new Error("The saved project changed outside this open estimate. Reload the project before editing its details; your current draft has been kept.");
      selected = {kind:"saved",file:{...file,...result.file,id:result.id || file.id},revision:result.revision,baseline:normalize(result.details),requestId:crypto.randomUUID(),activeAtOpen:active};
      // An open estimate may already contain identity edits. Keep those edits in
      // the pane; the metadata endpoint still checks the saved file revision.
      const values = active.file?.path === result.file?.path ? {...active.details,project_no:result.details.project_no} : result.details;
      show(normalize(values), result.file?.title || file.title || file.name || translate("Project"));
    } catch (error) { if (generation === ticket) { selected = {kind:"saved",file,baseline:normalize({}),blocked:true}; notice(error.message, true); } }
    finally { if (generation === ticket) busy(false); }
  }
  async function openCurrent() {
    if (!await leave()) return;
    const active = snapshot();
    if (currentRule?.context !== active.context) currentRule = {context:active.context,baseline:normalize(active.details)};
    selected = {kind:"current",context:active.context,baseline:currentRule.baseline};
    show(normalize(active.details), active.file?.title || translate("New project"));
    $("project-pane-client").focus();
  }
  function validateClient() {
    const value = details();
    if (value.client && value.client !== selected.baseline.client && (!value.account_id || value.client !== accountName)) {
      $("project-pane-client").focus();
      throw new Error("Choose an existing Account for this client, or use + to create an Account.");
    }
    return value;
  }
  function applyCurrentDraft() {
    if (selected?.kind !== "current") return;
    try { window.CeasefireProject.applyProjectPaneDraft(details(), selected.context); }
    catch (error) { notice(error.message, true); }
  }
  async function save() {
    if (!selected || pending || selected.blocked) return;
    if (selected.kind === "current") { validateClient(); return; }
    if (snapshot().busy) throw new Error("Finish the current project operation first.");
    const value = validateClient(), active = snapshot(), target = selected;
    if (active.file?.path === target.file.path && (active.file.revision !== target.revision || active.context !== target.activeAtOpen.context || stamp(active.details) !== stamp(target.activeAtOpen.details))) throw new Error("The open project's details changed. Close and reopen this pane before saving.");
    if (target.requestPayload && target.requestPayload !== stamp(value)) target.requestId = crypto.randomUUID();
    target.requestPayload = stamp(value);
    busy(true); dismissOptions(); notice("Saving project details…");
    try {
      const result = await request("/api/projects/details/save", {id:target.file.id,revision:target.revision,details:value,request_id:target.requestId});
      window.CeasefireProject.applyProjectPaneSaved(active, result, target.revision);
      target.file = {...target.file,...result.file,id:result.id || target.file.id};
      target.revision = result.revision; target.baseline = normalize(result.details); target.activeAtOpen = sharedStamp(snapshot().details) === sharedStamp(value) ? snapshot() : active; target.requestId = crypto.randomUUID(); target.requestPayload = null;
      show(target.baseline, result.file?.title || target.file.title || translate("Project"));
      notice("Project details saved.");
      await window.CeasefireProject.refreshProjectCards();
    } catch (error) { notice(error.message, true); throw error; }
    finally { busy(false); }
  }
  function chooseAccount(account) {
    accountId = account.id; accountName = account.company;
    if (selected?.kind === "current" && currentRule) currentRule.account = {id:account.id,company:account.company};
    $("project-pane-client").value = account.company;
    dismissOptions(); notice(); applyCurrentDraft();
  }
  function renderAccounts() {
    if (!selected || pending || document.activeElement !== $("project-pane-client")) return;
    const query = $("project-pane-client").value.trim().toLocaleLowerCase();
    options = accounts.filter(account => account.company.toLocaleLowerCase().includes(query)).slice(0,30);
    const host = $("project-account-options");
    host.replaceChildren(...options.map((account,index) => {
      const option = document.createElement("button"); option.type = "button"; option.id = `project-account-option-${index}`;
      option.setAttribute("role","option"); option.setAttribute("aria-selected","false"); option.textContent = account.company;
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => chooseAccount(account)); return option;
    }));
    if (!options.length) { const empty = document.createElement("p"); text(empty,"No matching Accounts. Use + to create one."); host.append(empty); }
    host.hidden = false; $("project-pane-client").setAttribute("aria-expanded","true"); optionIndex = -1;
  }
  async function loadAccounts() {
    const generation = ++directoryTicket;
    try {
      const directory = await request("/api/contacts/directory");
      if (generation !== directoryTicket) return;
      accounts = directory.accounts || []; renderAccounts();
    } catch (error) { if (generation === directoryTicket) notice(error.message, true); }
  }
  $("project-current-details").addEventListener("click", openCurrent);
  $("project-details-close").addEventListener("click", leave);
  $("project-details-form").addEventListener("submit", event => { event.preventDefault(); void save().catch(error => notice(error.message,true)); });
  for (const [key,id] of Object.entries(fields)) $(id).addEventListener("input", () => {
    if (!selected || pending) return;
    if (key === "client") {
      const value = $(id).value.trim();
      if (value !== accountName) { accountId = value === selected.baseline.client ? selected.baseline.account_id : ""; if (accountId) accountName = value; }
      renderAccounts();
    }
    applyCurrentDraft();
  });
  $("project-pane-client").addEventListener("focus", () => { renderAccounts(); void loadAccounts(); });
  $("project-pane-client").addEventListener("blur", () => { if (!$("project-account-options").contains(document.activeElement)) dismissOptions(); });
  $("project-pane-client").addEventListener("keydown", event => {
    if (event.key === "Escape") { dismissOptions(); event.preventDefault(); return; }
    if (!["ArrowDown","ArrowUp","Enter"].includes(event.key) || $("project-account-options").hidden || !options.length) return;
    if (event.key === "Enter") { if (optionIndex >= 0) { chooseAccount(options[optionIndex]); event.preventDefault(); } return; }
    event.preventDefault(); optionIndex = (optionIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    for (const [index,option] of [...$("project-account-options").children].entries()) option.setAttribute("aria-selected",String(index === optionIndex));
    $("project-pane-client").setAttribute("aria-activedescendant", `project-account-option-${optionIndex}`);
  });
  $("project-account-new").addEventListener("click", async () => {
    if (!selected || pending) return;
    const target = selected;
    busy(true); dismissOptions();
    try {
      if (!window.ClassifireContacts?.createAccount) throw new Error("Refresh the application before creating an Account.");
      const account = await window.ClassifireContacts.createAccount({company:$("project-pane-client").value.trim()});
      if (account && selected === target) { accounts = [...accounts.filter(value => value.id !== account.id),account]; chooseAccount(account); }
    } catch (error) { notice(error.message, true); }
    finally { busy(false); }
  });
  window.CeasefireProjectPane = Object.freeze({
    openCurrent, toggle: file => !pane.hidden && selected?.file?.id === file.id ? leave() : open(file), refreshToggles, leave,
    hasUnsavedChanges:dirty, hasPendingOperation:() => pending, fingerprint:() => selected ? JSON.stringify({id:selected.file?.id,context:selected.context,values:details()}) : "",
    async beforeProjectSave() {
      if (pending) throw new Error("Finish the current project details action before saving.");
      const active = snapshot();
      if (currentRule?.context === active.context && active.details.client && active.details.client !== currentRule.baseline.client && (active.details.account_id !== currentRule.account?.id || active.details.client !== currentRule.account?.company)) throw new Error("Choose an existing Account for this client, or use + to create an Account in Current project details.");
      if (selected?.kind === "current") validateClient();
      else if (dirty() && snapshot().file?.path === selected.file.path) await save();
    },
    projectSaved(savedDetails) {
      const active = snapshot(), account = currentRule?.context === active.context ? currentRule.account : null;
      currentRule = {context:active.context,baseline:normalize(savedDetails || active.details)};
      if (account?.id === active.details.account_id && account?.company === active.details.client) currentRule.account = account;
      if (selected?.kind === "current" && selected.context === active.context) { selected.baseline = currentRule.baseline; show(normalize(active.details),active.file?.title || translate("Project")); }
      else if (selected?.kind === "saved" && selected.file.path === active.file?.path) {
        selected.file = {...selected.file,...active.file}; selected.revision = active.file.revision;
        selected.baseline = currentRule.baseline; selected.activeAtOpen = active; selected.requestPayload = null; selected.requestId = crypto.randomUUID();
        show(normalize(active.details),active.file.title || translate("Project"));
      }
    },
  });
})();
