(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const pane = $("project-details-pane");
  if (!pane) return;
  const dialog = $("project-new-dialog"), home = pane.parentNode, homeNext = pane.nextSibling;
  const side = $("project-workspace-side"), links = $("project-workspace-links"), pricingNotice = $("project-pricing-notice");
  const translate = source => window.CeasefireI18n?.translate?.(source) || source;
  const text = (element,source) => window.CeasefireI18n ? window.CeasefireI18n.text(element,source) : (element.textContent=source);
  const fields = {project_no:"project-pane-number", client:"project-pane-client", site_address:"project-pane-address", contact_name:"project-pane-contact-name", contact_phone:"project-pane-contact-phone", contact_email:"project-pane-contact-email", billing_address:"project-pane-billing-address", abn_acn:"project-pane-abn-acn"};
  const metadataControls = [...pane.querySelectorAll("input,textarea,button"),...$("project-details-actions").querySelectorAll("button")];
  const participantSlots = [$("project-company-participants"),$("project-contact-participants")];
  function revealField(control) {
    const section = control.closest("details");
    if (section) section.open = true;
  }
  function focusField(id) {
    const control = $(id);
    revealField(control);
    control.focus();
  }
  $("project-details-form").addEventListener("invalid", event => revealField(event.target), true);
  const required = {project_no:"Project No.",client:"Client",site_address:"Site Address",contact_name:"Primary contact",contact_email:"Contact email",contact_phone:"Contact phone"};
  for (const key of Object.keys(required)) {
    const control = $(fields[key]);
    control.setAttribute("aria-required","true");
    // The server owns the number; readonly controls do not participate in the
    // browser's required constraint before a new Project has been allocated.
    control.required = true;
  }
  const normalize = details => Object.fromEntries([...Object.keys(fields), "account_id", "contact_id"].map(key => [key, String(details?.[key] || "").trim()]));
  const stamp = details => JSON.stringify(normalize(details));
  const sharedStamp = details => { const value = normalize(details); delete value.project_no; return JSON.stringify(value); };
  const snapshot = () => window.CeasefireProject.projectPaneSnapshot();
  const headerDetails = $("header-project-details");
  headerDetails.querySelector("button").addEventListener("click", () => headerDetails.close());
  function showHeaderDetails() {
    const current = snapshot();
    if (current.busy || !current.file?.title || headerDetails.open) return;
    const list = headerDetails.querySelector("dl");
    const rows = [];
    for (const [key,id] of Object.entries(fields)) {
      const row = document.createElement("div"), term = document.createElement("dt"), value = document.createElement("dd");
      const label = $(id).labels[0];
      term.textContent = (label.querySelector("span") || label).textContent;
      value.textContent = current.details[key] || "—";
      row.append(term,value); rows.push(row);
    }
    list.replaceChildren(...rows);
    headerDetails.querySelector(".header-project-details-title").textContent = current.file.title;
    const editor = document.activeElement;
    const selection = typeof editor?.selectionStart === "number"
      ? [editor.selectionStart,editor.selectionEnd,editor.selectionDirection] : null;
    const left = window.scrollX, top = window.scrollY;
    headerDetails.addEventListener("close",() => {
      if (!editor?.isConnected || editor.closest("[hidden]")) return;
      editor.focus({preventScroll:true});
      if (selection) editor.setSelectionRange(...selection);
      if (window.scrollX !== left || window.scrollY !== top) window.scrollTo({left,top,behavior:"instant"});
    },{once:true});
    headerDetails.showModal();
  }
  let selected = null, ticket = 0, pending = false, accounts = [], accountId = "", accountName = "", optionIndex = -1, options = [], directoryTicket = 0, currentRule = null;
  let contacts = [], contactId = "", contactName = "", contactOptions = [], contactOptionIndex = -1, contactLoading = false, contactPopupRequested = false, returningContactFocus = false;
  function details() { return {...Object.fromEntries(Object.entries(fields).map(([key,id]) => [key,$(id).value.trim()])), account_id:accountId, contact_id:contactId}; }
  function dirty() { return !!selected && ["saved","new"].includes(selected.kind) && stamp(details()) !== stamp(selected.baseline); }
  const directoryFields = {abn_acn:'ABN/ACN',billing_address:'Billing address',contact_email:'Email',contact_phone:'Phone'};
  const pendingDirectoryFields = new Map();
  function directoryEdits(values, baseline) {
    return Object.keys(directoryFields).filter(key => {
      const party = key.startsWith('contact_') ? 'contact_id' : 'account_id';
      return values?.[party] && values[key] && (values[key] !== baseline?.[key] || values[party] !== baseline?.[party]);
    });
  }
  async function syncDirectory(file, edits) {
    const project = file?.save_token ? 'native:' + file.save_token : file?.id;
    if (!project || !file.revision) return;
    const identity = file.path || project;
    let fields = [...new Set([...(pendingDirectoryFields.get(identity) || []), ...edits])];
    const accepted = {}, identityReviews = {};
    while (fields.length) {
      pendingDirectoryFields.set(identity, fields);
      let result;
      try {
        result = await request('/api/contacts/sync-project-details', {project, revision:file.revision, fields, accepted,identity_reviews:identityReviews});
      } catch (error) {
        const review = error.duplicateReview;
        if (!review) throw error;
        const names = review.matches.filter(match=>match.strong)
          .map(({fields})=>[fields.name || fields.company,fields.abn_acn || fields.email].filter(Boolean).join(' · '));
        if (await window.CeasefireDialogs.confirm(translate('Review possible duplicate records before saving.'),names.join('\n'),
          translate('Keep these records separate'),translate('Keep saved value'))) {
          identityReviews[review.kind] = review.review_token;
        } else {
          const skipped = fields.filter(key => key.startsWith('contact_') === (review.kind === 'contacts'));
          fields = fields.filter(key=>!skipped.includes(key));
          for (const key of skipped) delete accepted[key];
        }
        continue;
      }
      if (!result.conflicts.length) break;
      for (const conflict of result.conflicts) {
        const key = conflict.field;
        if (await window.ClassifireContacts.confirmDirectoryChange(directoryFields[key], conflict.name, conflict.saved, conflict.entered)) {
          accepted[key] = {id:conflict.id,expected:conflict.saved};
        } else {
          fields = fields.filter(field => field !== key);
          delete accepted[key];
        }
      }
    }
    pendingDirectoryFields.delete(identity);
  }
  function notice(value = "", error = false) {
    text($("project-details-status"), value);
    $("project-details-status").classList.toggle("error", error);
  }
  function busy(value) {
    pending = value; pane.setAttribute("aria-busy", String(value));
    const recovering = selected?.kind === "new" && selected.creation?.uncertain;
    for (const control of metadataControls) control.disabled = value || recovering && control.id !== "project-details-save" || !!selected?.blocked && control.id !== "project-details-close";
    for (const slot of participantSlots) slot.inert = !!(value || recovering || selected?.blocked);
    links.inert = !!(value || recovering || selected?.blocked);
    $("project-current-details").disabled = value;
  }
  function dismissOptions() {
    $("project-account-options").hidden = true;
    $("project-pane-client").setAttribute("aria-expanded", "false");
    $("project-pane-client").removeAttribute("aria-activedescendant");
    optionIndex = -1;
  }
  function dismissContactOptions() {
    contactPopupRequested = false;
    $("project-contact-options").hidden = true;
    $("project-pane-contact-name").setAttribute("aria-expanded", "false");
    $("project-pane-contact-name").removeAttribute("aria-activedescendant");
    contactOptionIndex = -1;
  }
  function hide() {
    window.ClassifireProjectParticipants?.close();
    window.ClassifireProjectRecordPanels?.close();
    const previous = selected;
    ++ticket; selected = null; pane.hidden = true;
    side.hidden = true; links.hidden = true; pricingNotice.hidden = true;
    $("project-workspace-layout").hidden = true;
    $("project-register").hidden = false;
    $("project-list-card").hidden = false;
    $("project-browser").hidden = true;
    if (dialog?.open) dialog.close();
    if (pane.parentNode !== home) home.insertBefore(pane, homeNext);
    if (previous?.kind === "new") void window.CeasefireProject.discardNewProject(previous.creation).catch(()=>{});
    busy(false);
    $("project-workspace-layout").classList.remove("project-pane-open");
    dismissOptions(); dismissContactOptions();
    window.scrollTo({top:0,left:0,behavior:"instant"});
  }
  async function leave() {
    if (pending || selected?.creation?.uncertain || window.ClassifireProjectParticipants?.pending() || window.ClassifireProjectRecordPanels?.pending()) { notice("Finish the current project details action first.", true); return false; }
    if (!await (window.ClassifireProjectRecordPanels?.leave() ?? true)) return false;
    if (dirty() && !await window.CeasefireDialogs.confirm(translate("Discard unsaved project details?"), translate("The changes in this Project Details pane have not been saved. Discard them?"), translate("Yes"), translate("Cancel"))) return false;
    hide(); return true;
  }
  function show(values, target) {
    window.ClassifireProjectParticipants?.show(selected.kind==="saved" ? selected.file : selected.kind==="current" ? snapshot().file : null);
    for (const [key,id] of Object.entries(fields)) $(id).value = values[key] || "";
    accountId = values.account_id || ""; accountName = values.client || "";
    contactId = values.contact_id || ""; contactName = values.contact_name || ""; contactLoading = false;
    $("project-details-target").textContent = target;
    $("project-details-save").hidden = selected.kind === "current";
    text($("project-details-save"),selected.kind === "new" ? "Save project" : "Save project details");
    $("project-new-cancel").hidden = selected.kind !== "new";
    pane.hidden = false;
    $("project-workspace-layout").hidden = selected.kind === "new";
    $("project-workspace-layout").classList.toggle("project-pane-open",selected.kind !== "new");
    $("project-register").hidden = selected.kind !== "new";
    $("project-list-card").hidden = selected.kind !== "new";
    $("project-browser").hidden = true;
    side.hidden = selected.kind === "new"; links.hidden = selected.kind === "new";
    if (selected.kind !== "new") window.ClassifireProjectRecordPanels?.show(selected.kind === "saved" ? selected.file : snapshot().file);
    // Pricing belongs to the active Project, not an unrelated saved-file pane.
    pricingNotice.hidden = selected.kind === "new" || selected.kind === "saved" && selected.file.path !== snapshot().file?.path;
    notice(selected.kind === "current" ? "Use the main Save button to save this project's details and estimate." : "");
    dismissOptions(); dismissContactOptions();
  }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? undefined : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || "Project details could not be updated.");
      error.duplicateReview = value.duplicate_review;
      throw error;
    }
    return value;
  }
  async function open(file) {
    if (snapshot().busy || !await leave()) return;
    const generation = ++ticket;
    selected = {kind:"saved",file,baseline:normalize({})};
    show({}, file.title || file.name || translate("Project")); busy(true); notice("Loading project details…");
    window.scrollTo({top:0,left:0,behavior:"instant"});
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
    focusField(fields.client);
    window.scrollTo({top:0,left:0,behavior:"instant"});
  }
  async function openNew() {
    if (snapshot().busy || !await leave()) return;
    const active = snapshot();
    selected = {kind:"new",context:active.context,baseline:normalize({}),creation:{id:crypto.randomUUID(),context:active.context}};
    dialog.append(pane); show(normalize({}),translate("New project"));
    dialog.showModal(); focusField(fields.client);
  }
  function validateClient() {
    const value = details();
    if (value.client && value.client !== selected.baseline.client && (!value.account_id || value.client !== accountName)) {
      focusField(fields.client);
      throw new Error("Choose an existing Company for this client, or use + to create a Company.");
    }
    return value;
  }
  function validateRequired(value, automaticNumber = false, focus = true) {
    const missing = Object.keys(required).filter(key => !(key === "project_no" && automaticNumber) && !String(value[key] || "").replace(/\p{Cf}/gu,"").trim());
    if (missing.length) {
      if (focus && !pane.hidden) focusField(fields[missing.find(key => key !== "project_no") || missing[0]]);
      throw new Error(translate("Complete required Project details: {0}.").replace("{0}",missing.map(key=>translate(required[key])).join(", ")));
    }
    if (focus && !pane.hidden && !$(fields.contact_email).checkValidity()) {
      $(fields.contact_email).reportValidity();
      throw new Error("Enter a valid contact email address.");
    }
    return value;
  }
  function applyCurrentDraft() {
    if (selected?.kind !== "current") return;
    try { window.CeasefireProject.applyProjectPaneDraft(details(), selected.context); }
    catch (error) { notice(error.message, true); }
  }
  function rebaseCurrentRule(savedDetails) {
    const active = snapshot(), account = currentRule?.context === active.context ? currentRule.account : null;
    currentRule = {context:active.context,baseline:normalize({...savedDetails,project_no:active.details.project_no})};
    if (account?.id === active.details.account_id && account?.company === active.details.client) currentRule.account = account;
  }
  function projectDetailsChanged() {
    const active = snapshot();
    if (currentRule?.context === active.context) currentRule.account = active.details.account_id && active.details.client ? {id:active.details.account_id,company:active.details.client} : null;
    if (!selected || pending || selected.blocked || pane.hidden) return;
    if (selected.kind === "current" && selected.context === active.context) {
      if (stamp(details()) !== stamp(active.details)) show(normalize(active.details),active.file?.title || translate("Project"));
    } else if (selected.kind === "saved" && selected.file.path === active.file?.path && !dirty()) {
      // Keep the saved baseline/revision until a real save succeeds. External
      // edits are now this pane's unsaved draft; never replace a separate draft.
      selected.activeAtOpen = active;
      if (stamp(details()) !== stamp(active.details)) show(normalize(active.details),active.file.title || translate("Project"));
    }
  }
  async function save() {
    if (!selected || pending || selected.blocked) return;
    if (selected.kind === "current") { validateClient(); return; }
    if (snapshot().busy || window.ClassifireProjectParticipants?.pending() || window.ClassifireProjectRecordPanels?.pending()) throw new Error("Finish the current project operation first.");
    if (selected.kind === "new") {
      const target = selected, value = validateRequired(validateClient(),true);
      if (target.creation.details && target.creation.details !== stamp(value)) {
        await window.CeasefireProject.discardNewProject(target.creation);
        target.creation = {id:crypto.randomUUID(),context:target.context};
      }
      target.creation.details = stamp(value);
      busy(true); dismissOptions(); dismissContactOptions(); notice("Saving project details…");
      try {
        const result = await window.CeasefireProject.createProject(value,target.creation);
        if (selected !== target) return;
        if (result?.saved) { hide(); return; }
        notice(result?.cancelled ? "Save cancelled. Your current project remains open." : "");
      } catch (error) {
        notice(target.creation.uncertain ? "The project save result could not be confirmed. Retry Save to recover it." : error.message,true);
      } finally { busy(false); }
      return;
    }
    const value = validateRequired(validateClient()), active = snapshot(), target = selected;
    const edits = directoryEdits(value,target.baseline);
    if (active.file?.path === target.file.path && (active.file.revision !== target.revision || active.context !== target.activeAtOpen.context || stamp(active.details) !== stamp(target.activeAtOpen.details))) throw new Error("The open project's details changed. Close and reopen this pane before saving.");
    if (target.requestPayload && target.requestPayload !== stamp(value)) target.requestId = crypto.randomUUID();
    target.requestPayload = stamp(value);
    busy(true); dismissOptions(); dismissContactOptions(); notice("Saving project details…");
    try {
      const result = await request("/api/projects/details/save", {id:target.file.id,revision:target.revision,details:value,request_id:target.requestId});
      if (window.CeasefireProject.applyProjectPaneSaved(active, result, target.revision)) rebaseCurrentRule(result.details);
      target.file = {...target.file,...result.file,id:result.id || target.file.id};
      target.revision = result.revision; target.baseline = normalize(result.details); target.activeAtOpen = sharedStamp(snapshot().details) === sharedStamp(value) ? snapshot() : active; target.requestId = crypto.randomUUID(); target.requestPayload = null;
      show(target.baseline, result.file?.title || target.file.title || translate("Project"));
      try { await syncDirectory(target.file, edits); }
      catch (error) {
        const warning = translate("Project saved. Directory details still need syncing. {0}").replace("{0}",error.message);
        throw new Error(warning);
      }
      notice("Project details saved.");
    } catch (error) { notice(error.message, true); throw error; }
    finally { busy(false); }
    // The write is complete. Loading the folder list has its own status and
    // can continue while the user edits again or leaves this pane.
    void window.CeasefireProject.refreshProjectCards();
  }
  const companyKey = value => String(value || "").trim().replace(/\s+/g," ").toLocaleLowerCase();
  function companyNamed(name) {
    const matching = accounts.filter(account => companyKey(account.company) === companyKey(name));
    return matching.length === 1 ? matching[0] : null;
  }
  function contactCompany(contact) {
    if (contact.account_id) return accounts.find(account => account.id === contact.account_id) || null;
    // Older directory fixtures may not carry IDs. An explicit null means this
    // Contact has no Company, so only a missing ID may use the legacy name.
    return Object.hasOwn(contact,"account_id") ? null : companyNamed(contact.company);
  }
  function contactMatchesClient(contact) {
    const name = $("project-pane-client").value.trim();
    if (!name) return true;
    const client = accountId ? accounts.find(account => account.id === accountId) : companyNamed(name);
    return Boolean(client && contactCompany(contact)?.id === client.id);
  }
  function setAccount(account) {
    const previous = accounts.find(value => value.id === accountId) || companyNamed(accountName);
    for (const key of ["billing_address","abn_acn"]) {
      const input = $(fields[key]);
      if (!account || !input.value.trim() || input.value.trim() === String(previous?.[key] || "").replace(/\r\n?/g,"\n").trim()) input.value = account?.[key] || "";
    }
    accountId = account?.id || ""; accountName = account?.company || "";
    if (selected?.kind === "current" && currentRule) currentRule.account = account ? {id:account.id,company:account.company} : null;
    $("project-pane-client").value = accountName;
  }
  function clearContact(clearClient = false) {
    contactId = ""; contactName = "";
    $("project-pane-contact-name").value = "";
    $("project-pane-contact-phone").value = ""; $("project-pane-contact-email").value = "";
    if (clearClient) setAccount(null);
  }
  function invalidateLinkedContact() {
    if (!contactId) return;
    const contact = contacts.find(contact => contact.id === contactId);
    if (!contact || !contactMatchesClient(contact) || (!$("project-pane-client").value.trim() && contactCompany(contact))) clearContact();
  }
  function chooseAccount(account) {
    setAccount(account); invalidateLinkedContact(); dismissContactOptions();
    dismissOptions(); notice(); applyCurrentDraft();
    window.ClassifireProjectParticipants?.primaryChanged();
  }
  function chooseContact(contact) {
    if (!selected || pending) return;
    setAccount(contactCompany(contact));
    contactId = contact.id; contactName = contact.name;
    $("project-pane-contact-name").value = contact.name;
    // Defaults are copied once when the user explicitly chooses a Contact.
    // Reopening the pane never replaces project-specific phone/email overrides.
    $("project-pane-contact-phone").value = contact.phone || "";
    $("project-pane-contact-email").value = contact.email || "";
    dismissContactOptions(); notice(); applyCurrentDraft();
    window.ClassifireProjectParticipants?.primaryChanged();
    returningContactFocus = true; $("project-pane-contact-name").focus(); returningContactFocus = false;
    dismissContactOptions();
  }
  function renderContacts() {
    if (!contactPopupRequested || !selected || pending || selected.blocked || document.activeElement !== $("project-pane-contact-name")) return;
    const query = $("project-pane-contact-name").value.trim().toLocaleLowerCase();
    contactOptions = contactLoading ? [] : contacts.filter(contact => contactMatchesClient(contact) && [contact.name,contact.company,contact.phone,contact.email].join(" ").toLocaleLowerCase().includes(query)).slice(0,30);
    const host = $("project-contact-options");
    host.replaceChildren(...contactOptions.map((contact,index) => {
      const option = document.createElement("button"); option.type = "button"; option.tabIndex = -1; option.id = `project-contact-option-${index}`;
      option.setAttribute("role","option"); option.setAttribute("aria-selected","false");
      option.setAttribute("aria-posinset",String(index + 1)); option.setAttribute("aria-setsize",String(contactOptions.length));
      option.dataset.contactId = contact.id; option.textContent = contact.name;
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => chooseContact(contact));
      return option;
    }));
    if (!contactOptions.length) {
      const empty = document.createElement("p"); text(empty,contactLoading ? "Loading Contacts…" : "No matching Contacts."); host.append(empty);
    }
    host.hidden = false; $("project-pane-contact-name").setAttribute("aria-expanded","true");
    $("project-pane-contact-name").removeAttribute("aria-activedescendant"); contactOptionIndex = -1;
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
    if (!options.length) { const empty = document.createElement("p"); text(empty,"No matching Companies. Use + to create one."); host.append(empty); }
    host.hidden = false; $("project-pane-client").setAttribute("aria-expanded","true"); optionIndex = -1;
  }
  async function loadAccounts() {
    const generation = ++directoryTicket;
    const target = selected, opening = ticket;
    try {
      const directory = await request("/api/contacts/directory");
      if (generation !== directoryTicket || selected !== target || ticket !== opening || !selected) return;
      accounts = directory.accounts || []; contacts = directory.contacts || []; contactLoading = false;
      renderAccounts(); renderContacts();
    } catch (error) {
      if (generation === directoryTicket && selected === target && ticket === opening && selected) {
        contactLoading = false; contacts = []; renderContacts(); notice(error.message, true);
      }
    }
  }
  $("project-current-details").addEventListener("click", openCurrent);
  $("project-details-close").addEventListener("click", leave);
  $("project-details-toolbar-save").addEventListener("click", () => {
    if (!selected || pending || selected.blocked || snapshot().busy) return;
    if (selected.kind === "current") $("save-current-project").click();
    else $("project-details-form").requestSubmit();
  });
  $("project-new-cancel").addEventListener("click", leave);
  dialog.addEventListener("cancel",event=>{event.preventDefault();void leave();});
  $("project-details-form").addEventListener("submit", event => { event.preventDefault(); void save().catch(error => notice(error.message,true)); });
  for (const [key,id] of Object.entries(fields)) $(id).addEventListener("input", () => {
    if (!selected || pending) return;
    if (key === "client") {
      const value = $(id).value.trim();
      if (value !== accountName) { accountId = value === selected.baseline.client ? selected.baseline.account_id : ""; if (accountId) accountName = value; }
      if (!value) setAccount(null);
      invalidateLinkedContact(); dismissContactOptions();
      renderAccounts();
    }
    if (key === "contact_name") {
      if ($(id).value.trim() !== contactName) contactId = "";
      if (!$(id).value.trim()) clearContact(true);
      contactPopupRequested = true;
      renderContacts();
    }
    applyCurrentDraft();
    if (key === "client" || key === "contact_name") window.ClassifireProjectParticipants?.primaryChanged();
  });
  $("project-pane-client").addEventListener("focus", () => { dismissContactOptions(); renderAccounts(); void loadAccounts(); });
  $("project-pane-contact-name").addEventListener("focus", () => { if (returningContactFocus) return; dismissOptions(); contactPopupRequested = true; contactLoading = true; renderContacts(); void loadAccounts(); });
  for (const type of ["pointerdown","focusin"]) document.addEventListener(type, event => {
    if (!$("project-pane-contact-name").closest(".project-contact-field").contains(event.target)) dismissContactOptions();
  });
  $("project-pane-contact-name").addEventListener("keydown", event => {
    if (event.key === "Escape") { dismissContactOptions(); event.preventDefault(); event.stopPropagation(); return; }
    if (!["ArrowDown","ArrowUp","Enter"].includes(event.key)) return;
    if ($("project-contact-options").hidden && event.key !== "Enter") { contactPopupRequested = true; renderContacts(); }
    if (event.key === "Enter") {
      if (!$("project-contact-options").hidden) { if (contactOptionIndex >= 0) chooseContact(contactOptions[contactOptionIndex]); event.preventDefault(); }
      return;
    }
    if (!contactOptions.length) return;
    event.preventDefault();
    contactOptionIndex = contactOptionIndex < 0 ? (event.key === "ArrowDown" ? 0 : contactOptions.length-1) : (contactOptionIndex + (event.key === "ArrowDown" ? 1 : -1) + contactOptions.length) % contactOptions.length;
    for (const [index,option] of [...$("project-contact-options").children].entries()) option.setAttribute("aria-selected",String(index === contactOptionIndex));
    $("project-pane-contact-name").setAttribute("aria-activedescendant", `project-contact-option-${contactOptionIndex}`);
  });
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
    busy(true); dismissOptions(); dismissContactOptions();
    try {
      if (!window.ClassifireContacts?.createAccount) throw new Error("Refresh the application before creating a Company.");
      const account = await window.ClassifireContacts.createAccount({company:$("project-pane-client").value.trim()});
      if (account && selected === target) { accounts = [...accounts.filter(value => value.id !== account.id),account]; chooseAccount(account); }
    } catch (error) { notice(error.message, true); }
    finally { busy(false); }
  });
  $("project-contact-new").addEventListener("click",async()=>{
    if (!selected || pending) return;
    const target = selected; busy(true); dismissOptions(); dismissContactOptions();
    try {
      if (!window.ClassifireContacts?.createContact) throw new Error("Refresh the application before creating a Contact.");
      const contact = await window.ClassifireContacts.createContact({name:$("project-pane-contact-name").value.trim(),...(accountId ? {account_id:accountId} : {})});
      if (contact && selected === target) {
        if (contact.account_id && contact.company) {
          const account = accounts.find(account => account.id === contact.account_id);
          accounts = [...accounts.filter(account => account.id !== contact.account_id),{...account,id:contact.account_id,company:contact.company}];
        }
        contacts = [...contacts.filter(value=>value.id !== contact.id),contact]; busy(false); chooseContact(contact);
      }
    } catch(error) { if(selected === target) notice(error.message,true); }
    finally { busy(false); }
  });
  window.CeasefireProjectPane = Object.freeze({
    directoryEdits, syncDirectory, showHeaderDetails,
    currentDirectoryEdits(values) {
      const active = snapshot();
      return currentRule?.context === active.context ? directoryEdits(values,currentRule.baseline) : [];
    },
    open,openCurrent,openNew, toggle: file => !pane.hidden && selected?.file?.id === file.id ? leave() : open(file), leave, projectDetailsChanged,
    primaryParties: () => ({accounts:accountId,contacts:contactId}),
    savePendingDetails: async () => { if (dirty()) await save(); },
    closeAfterReplacement: hide,
    hasUnsavedChanges:()=>dirty() || Boolean(window.ClassifireProjectRecordPanels?.dirty()), hasPendingOperation:() => pending || !!selected?.creation?.uncertain || Boolean(window.ClassifireProjectRecordPanels?.pending()), fingerprint:() => selected ? JSON.stringify({id:selected.file?.id,context:selected.context,values:details(),resources:window.ClassifireProjectRecordPanels?.fingerprint()}) : "",
    async beforeProjectSave() {
      if (pending || window.ClassifireProjectParticipants?.pending() || window.ClassifireProjectRecordPanels?.pending() || window.ClassifireProjectRecordPanels?.dirty()) throw new Error("Finish the current project details action before saving.");
      if (selected?.kind === "new") throw new Error("Save or cancel the new project details first.");
      const active = snapshot();
      if (currentRule?.context === active.context && active.details.client && active.details.client !== currentRule.baseline.client && (active.details.account_id !== currentRule.account?.id || active.details.client !== currentRule.account?.company)) throw new Error("Choose an existing Company for this client, or use + to create a Company in Current project details.");
      if (selected?.kind === "current") validateRequired(validateClient(),!active.file?.save_token);
      else if (dirty() && snapshot().file?.path === selected.file.path) await save();
      const current = snapshot();
      try { validateRequired(current.details,!current.file?.save_token,false); }
      catch(error) {
        if (!$("view-quotes").hidden && (!selected || selected.kind === "current" || selected.file?.path === current.file?.path)) {
          if (selected?.kind !== "current") await openCurrent();
          validateRequired(details(),!current.file?.save_token);
        }
        throw error;
      }
    },
    projectSaved(savedDetails) {
      const active = snapshot(); rebaseCurrentRule(savedDetails || active.details);
      if (selected?.kind === "current" && selected.context === active.context) { selected.baseline = currentRule.baseline; show(normalize(active.details),active.file?.title || translate("Project")); }
      else if (selected?.kind === "saved" && selected.file.path === active.file?.path) {
        selected.file = {...selected.file,...active.file}; selected.revision = active.file.revision;
        selected.baseline = currentRule.baseline; selected.activeAtOpen = active; selected.requestPayload = null; selected.requestId = crypto.randomUUID();
        show(normalize(active.details),active.file.title || translate("Project"));
      }
    },
  });
})();
