(() => {
  "use strict";
  const titles = {leads: "Leads", contacts: "Contacts", accounts: "Companies"};
  const singular = {leads: "Lead", contacts: "Contact", accounts: "Company"};
  const labels = {name: "Name", phone: "Phone", company: "Company", title: "Title", email: "Email", abn_acn: "ABN/ACN",
    site_address: "Site address", billing_address: "Billing address", description: "Description", status: "Status",
    next_action: "Next action", follow_up_date: "Follow-up date", region:"Region", owner_id:"Owner", owner_name:"Owner", last_interaction_at:"Last interaction"};
  const personFields = ["name", "phone", "company", "title", "email"];
  const contactRequired = ["name", "phone", "company", "email"];
  const meaningful = value => Boolean(value.replace(/\p{Cf}/gu, '').trim());
  let page = "leads", data, search = "", generation = 0, saving = false, editorSequence = 0, editorRequest = 0, converting = null, accountEditor = null;
  let followUpBy = "";
  let followUpTimer;
  const linkTitles = {contacts: "Contacts", projects: "Projects", quotes: "Quotes", work_orders: "Work Orders", purchase_orders: "Purchase Orders"};
  const root = () => document.getElementById("contacts-root");
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  function copy(node, source, args = []) {
    if (window.CeasefireI18n) window.CeasefireI18n.text(node, source, args);
    else node.textContent = source.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match);
    return node;
  }
  const ui = (tag, cls, source, args) => copy(el(tag, cls), source, args);
  function confirmDirectoryChange(label, name, saved, entered) {
    const format = (key,args=[]) => window.CeasefireI18n?.translate(key,args) ??
      key.replace(/\{(\d+)\}/g,(match,index)=>args[index] ?? match);
    return window.CeasefireDialogs.confirm(format('Update {0} for {1}?',[format(label),name]),
      format('Saved: {0}\nEntered: {1}',[saved,entered]),format('Overwrite'),format('Keep saved value'));
  }
  function button(text, action, cls = "button secondary") {
    const node = el("button", cls, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function creationButton(label, action) {
    const control=button('',action,'button primary icon-only add-icon-action');
    control.title=label;control.setAttribute('aria-label',label);
    window.CeasefireI18n?.attr(control,'title',label);window.CeasefireI18n?.attr(control,'aria-label',label);
    const symbol=el('span','button-symbol add-symbol','+');symbol.setAttribute('aria-hidden','true');control.append(symbol);
    const access=window.ClassifireAccess;
    if(access){control.disabled=true;void access.ready.then(()=>{if(control.isConnected)control.disabled=!access.can('edit');});}
    return control;
  }
  function feedback(container, message, error = false) {
    const msg = container.querySelector("[data-contacts-notice]");
    copy(msg, message);
    msg.hidden = !message;
    msg.classList.toggle("error", error);
    msg.setAttribute("role", error ? "alert" : "status");
    if (message && error && msg.isConnected) msg.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
  }
  function notice() {
    const node = el("p", "notice");
    node.dataset.contactsNotice = "";
    node.setAttribute("role", "status");
    node.hidden = true;
    return node;
  }

  function participantProject(entry) {
    const row=el('span');
    row.append(ui('strong','',entry.role_label),document.createTextNode(' · '+[entry.project_no,entry.client,entry.site_address].filter(Boolean).join(' · ')));
    if(entry.availability==='unavailable')row.append(' · ',ui('small','helper','Saved project unavailable'));
    if(entry.availability==='unverified')row.append(' · ',ui('small','helper','Availability not yet verified'));
    return row;
  }
  function appendLeadGroup(groups, key, title, entries, render, open) {
    if (!entries.length) return;
    const group = el('details', 'contacts-links-group'), summary = el('summary');
    group.dataset.linkGroup = key;
    group.open = open;
    copy(summary, '{0} ({1})', [window.CeasefireI18n?.term(title) || title, entries.length]);
    const body = el('div', 'contacts-links-body'), list = el('ul', 'contacts-links-list');
    for (const entry of entries) {
      const row = el('li', 'contacts-link-row');
      row.append(render(entry)); list.append(row);
    }
    body.append(list); group.append(summary, body); groups.append(group);
  }

  function conversionDetails(receipt, openProject = false) {
    const conversion = el('div', 'contacts-conversion');
    const projectName = openProject && receipt.project_source ? button(receipt.project_no || "Project", async event => {
      const control = event.currentTarget;
      control.disabled = true;
      try { await window.CeasefireProject.openConvertedLead(receipt, control); }
      catch (error) { feedback(root(), error.message, true); }
      finally { control.disabled = false; }
    }, 'text-button') : el('span', '', receipt.project_no || '—');
    const identity = el('dl', 'kanban-card-details contacts-conversion-fields');
    const date = receipt.converted_at ? new Date(receipt.converted_at) : null;
    const convertedAt = el('time', '', date && Number.isFinite(date.getTime())
      ? date.toLocaleString(document.documentElement.lang || undefined) : '—');
    if (date && Number.isFinite(date.getTime())) convertedAt.dateTime = date.toISOString();
    const project = el('dd'), dateValue = el('dd');
    project.append(projectName);
    dateValue.append(convertedAt);
    identity.append(ui('dt', '', 'Project No.'), project,
      ui('dt', '', 'Site address'), el('dd', '', receipt.snapshot?.site_address || '—'),
      ui('dt', '', 'Date'), dateValue);
    conversion.append(identity);
    if (!receipt.snapshot) {
      conversion.append(ui('p', 'helper', 'Earlier conversion details were not recorded.'));
      return conversion;
    }
    const detail = el('details', 'contacts-conversion-snapshot'), fields = el('dl', 'kanban-card-details');
    detail.append(ui('summary', '', 'Lead Information'));
    if(receipt.actor_name)fields.append(ui('dt','','Logged by'),el('dd','',receipt.actor_name));
    for (const [key, label] of Object.entries(labels)) {
      const value = receipt.snapshot[key];
      if (value && key!=='owner_id') fields.append(ui('dt', '', key === 'status' ? 'Status at conversion' : label),
        key === 'status' ? ui('dd', '', value) : el('dd', '', value));
    }
    detail.append(fields);
    conversion.append(detail);
    return conversion;
  }
  async function request(path, body) {
    const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)};
    const response = await fetch("/api/contacts/" + path, options);
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || "The directory could not be updated.");
      error.status = response.status;
      error.matchingContacts = value.matching_contacts;
      error.duplicateReview = value.duplicate_review;
      error.matchingLeads = value.matching_leads;
      throw error;
    }
    return value;
  }
  async function activate(kind) {
    if (!await leaveAccount()) return false;
    const ticket = ++generation;
    if (Object.hasOwn(titles, kind)) page = kind;
    search = "";
    root().setAttribute("aria-busy", "true");
    try {
      const directory = await request(page === "leads" ? "directory?board=1" : "directory");
      if (ticket !== generation) return;
      data = directory;
      render();
      return true;
    } catch (error) {
      if (ticket !== generation) return;
      root().replaceChildren(el("p", "notice error", error.message), button("Retry", () => activate(page)));
    } finally {
      if (ticket === generation) root().removeAttribute("aria-busy");
    }
  }
  async function openDirectoryLead(id) {
    if (!await activate('leads')) return;
    const current = data.leads.find(item => item.id === id);
    if (current) dialogEditor('leads', current);
  }
  async function update(path, body, after) {
    if (saving) return;
    saving = true;
    try {
      const result = await request(path, body);
      after?.(result);
      await activate(page);
      if (root().querySelector("[data-contacts-notice]") && "added" in result)
        feedback(root(), `Imported ${result.added} new records. Matched ${result.matched} existing records.`);
      if (result.project_no) feedback(root(), `Project ${result.project_no} saved.`);
      return result;
    } finally { saving = false; conversionBusy(); }
  }
  async function leaveAccount() {
    const target = accountEditor;
    if (!target) return true;
    if (target.pending()) { target.notice(target.pendingMessage(), true); return false; }
    if (target.dirty()) {
      const captured = target.fingerprint();
      const translate = value => window.CeasefireI18n?.translate?.(value) || value;
      if (!await window.CeasefireDialogs.confirm(translate("Discard changes"), translate({contacts:"Discard changes to this contact?",accounts:"Discard changes to this company?",leads:"Discard changes to this lead?"}[target.kind]), translate("Yes"), translate("Cancel"))) return false;
      if (accountEditor !== target || target.pending()) return false;
      if (target.fingerprint() !== captured) { target.notice({contacts:"The Contact changed during review. Check the current changes and try again.",accounts:"The Company changed during review. Check the current changes and try again.",leads:"The Lead changed during review. Check the current changes and try again."}[target.kind], true); return false; }
    }
    target.close();
    return true;
  }
  async function dialogEditor(kind, record = {}, options = {}) {
    const requestId = ++editorRequest;
    if (!accountEditor && (saving || root()?.getAttribute("aria-busy") === "true")) return null;
    if (!await leaveAccount()) return null;
    await window.ClassifireAccess?.ready;
    if (requestId !== editorRequest || saving || root()?.getAttribute("aria-busy") === "true") return null;
    if (options.isCurrent && !options.isCurrent()) return null;
    const readOnly = Boolean(options.lockedReadOnly || window.ClassifireAccess && !window.ClassifireAccess.can("edit"));
    const inPane = ["accounts", "contacts", "leads"].includes(kind) && Boolean(record.id) && !options.standalone;
    const dialog = el(inPane ? "aside" : "dialog", inPane ? "contacts-account-pane" : "contacts-dialog");
    if (inPane && kind === "contacts") dialog.classList.add("contacts-contact-pane");
    const form = el("form", "contacts-form");
    const returnFocus = document.activeElement;
    let finished = false;
    const isOpen = () => inPane ? accountEditor?.element === dialog && dialog.isConnected && !finished : dialog.open;
    function closeEditor() {
      if (!inPane) { dialog.close(); return; }
      if (finished) return;
      finished = true;
      dialog.dispatchEvent(new Event("close"));
    }
    const directory = options.directory || data;
    let version = directory.version;
    const staff = readOnly ? Promise.resolve([]) : request('staff').then(result=>result.staff);
    staff.catch(()=>{});
    let contactId = record.contact_id || "", contactName = record.name || "", accountId = record.account_id || "";
    let accountDefaults = {};
    let resources = null, workspaceLeft, workspaceRight, associationPanel, associationLinks;
    let resolveClosed, savedRecord = null, submitting = false, loadingLinks = false, linksReady = kind !== "accounts", contactLinkRefresh, contactLinkLoading = false;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const heading = el("h2", "", readOnly ? (kind==='accounts' ? record.company : record.name) : (record.id ? "Edit " : "New ") + singular[kind]);
    if (!readOnly) copy(heading, (record.id ? "Edit " : "New ") + singular[kind]);
    heading.id = "contacts-editor-title-" + ++editorSequence;
    dialog.setAttribute("aria-labelledby", heading.id);
    form.append(heading, notice());
    const fields = {};
    const newContact = kind === 'contacts' && !record.id && !readOnly;
    const fieldErrors = {};
    // Collect inline errors together before any directory write; native
    // validation remains unchanged for legacy edits and other directory forms.
    if (newContact) form.noValidate = true;
    function group(headingText, keys) {
      const section = el("fieldset", "contacts-group");
      if (headingText === "Follow-up") section.classList.add("contacts-follow-up");
      section.append(ui("legend", "", headingText));
      for (const key of keys) {
        const label = el("label", "field");
        if (window.CeasefireI18n) window.CeasefireI18n.nodeText(label, labels[key]);
        else label.textContent = labels[key];
        let input;
        if (key === "status") {
          input = el("select");
          const choices=[...(directory.sales_stages || directory.statuses)];
          if(record.status && !choices.includes(record.status))choices.push(record.status);
          choices.forEach(value => input.add(new Option(window.CeasefireI18n?.translate(value) || value, value)));
        } else if(key==='owner_id') {
          input=window.ClassifireCrmActivity.ownerSelect(record);
          const ownerInput=input;
          staff.then(rows=>window.ClassifireCrmActivity.populate(ownerInput,rows)).catch(error=>feedback(form,error.message,true));
        } else if (["description", "billing_address", "site_address", "next_action"].includes(key)) {
          input = el("textarea");
          input.rows = key === "description" ? 3 : 2;
          if (key === "next_action") {
            input.maxLength = 500;
            const grow = () => {input.style.height="auto";input.style.height=Math.max(56,input.scrollHeight)+"px";};
            input.addEventListener("input",grow);queueMicrotask(grow);
          }
        } else {
          input = el("input");
          input.type = key === "email" ? "email" : key === "phone" ? "tel" : key === "follow_up_date" ? "date" : "text";
          if (key === "next_action") input.maxLength = 500;
        }
        if (key !== "owner_id") input.value = record[key] || (key === "status" ? directory.statuses[0] : "");
        input.required = newContact ? contactRequired.includes(key) : key === "name" || (key === "company" && kind !== "contacts");
        input.name = key;
        if (key==='owner_id' || key==='status') {
          input.setAttribute('aria-label', labels[key]);window.CeasefireI18n?.attr(input,'aria-label',labels[key]);
        }
        if (readOnly) { if (input.tagName === "SELECT") input.disabled = true; else input.readOnly = true; }
        fields[key] = input;
        label.append(input);
        if (newContact && contactRequired.includes(key)) {
          input.setAttribute('aria-label',labels[key]);window.CeasefireI18n?.attr(input,'aria-label',labels[key]);
          const error = ui('span', 'contacts-field-error', 'This field is required.');
          error.id = heading.id + '-' + key + '-error'; error.hidden = true;
          input.setAttribute('aria-describedby', error.id);
          input.setAttribute('aria-required', 'true');
          input.addEventListener('input', () => {input.setCustomValidity('');input.removeAttribute('aria-invalid');error.hidden=true;});
          fieldErrors[key] = error; label.append(error);
        }
        section.append(label);
      }
      form.append(section);
    }
    if (kind === "leads") {
      group("Lead Information", [...personFields, "abn_acn", "status", "owner_id"]);
      group("Address Information", ["site_address", "billing_address"]);
      group("Description", ["description"]);
      group("Follow-up", ["next_action", "follow_up_date"]);
    } else if (kind === "accounts") {
      group("Company Information", ["company", "abn_acn", "billing_address", "owner_id"]);
    } else {
      group("Contact Information", [...personFields, "owner_id"]);
    }
    const initialValues = Object.fromEntries(Object.entries(fields).map(([key,input]) => [key,input.value]));
    function arrangeLinkedGroups(groups) {
      if (!inPane || !associationLinks) return;
      associationLinks.replaceChildren();
      for (const group of [...groups.querySelectorAll(":scope>details[data-link-group]")]) {
        group.classList.add("card","commercial-side-panel");
        if (["companies","contacts"].includes(group.dataset.linkGroup)) associationLinks.append(group);
      }
      if (associationPanel) associationPanel.hidden = Boolean(associationLinks.querySelector('[data-link-group="companies"]'));
    }
    function linkedSummary(target, rows) {
      const list=el("dl","commercial-card-info");
      for(const [label,value] of rows)list.append(ui("dt","",label),el("dd","",value || "—"));
      target.append(list);
    }
    async function openAssociation(targetKind,id) {
      if (!await leaveAccount()) return;
      if (!await activate(targetKind)) return;
      const item=data[targetKind].find(row=>row.id===id);
      if(item)void dialogEditor(targetKind,item);
    }
    function showAssociation() {
      if(!associationPanel)return;
      const account=kind === "accounts" ? record : directory.accounts.find(item=>item.id===accountId);
      const name=kind === "accounts" ? fields.company.value : account?.company || fields.company?.value;
      associationPanel.replaceChildren(ui("summary","","Company Details"));
      if(name) {
        const card=el("article","commercial-linked-company");
        if(account && kind!=="accounts")card.append(button(name,()=>void openAssociation("accounts",account.id),"text-button project-title-button"));
        else card.append(el("strong","",name));
        linkedSummary(card,[["Billing address",kind==="accounts" ? fields.billing_address.value : account?.billing_address],["ABN/ACN",kind==="accounts" ? fields.abn_acn.value : account?.abn_acn]]);
        associationPanel.append(card);
      }
    }

    function accountSelection(account, setCompany = true) {
      accountId = account.id;
      if (setCompany) {
        fields.company.value = account.company;
        if (newContact) {fields.company.setCustomValidity('');fields.company.removeAttribute('aria-invalid');fieldErrors.company.hidden=true;}
      }
      for (const key of ['abn_acn','billing_address']) if(fields[key] && (!fields[key].value.trim() || fields[key].value === accountDefaults[key])) fields[key].value = account[key] || '';
      accountDefaults = {abn_acn:account.abn_acn || '',billing_address:account.billing_address || ''};
    }
    function lookup(input, records, searchable, caption, choose, emptyText, describe) {
      const label = input.closest('label'), box = el('div','contacts-lookup'), list = el('div','contacts-lookup-options');
      label.id = heading.id + '-' + input.name + '-label';
      list.id = heading.id + '-' + input.name + '-options';list.hidden = true;
      list.setAttribute('role','listbox');list.setAttribute('aria-label','Matching records');
      input.setAttribute('aria-label',labels[input.name]);window.CeasefireI18n?.attr(input,'aria-label',labels[input.name]);window.CeasefireI18n?.attr(list,'aria-label','Matching records');
      input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',list.id);input.autocomplete='off';
      label.replaceChild(box,input);box.append(input,list);
      let choices=[],active=-1;
      function hide(){list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
      function select(index){if(!choices[index]||submitting)return;choose(choices[index]);review.hidden=true;hide();input.focus();hide();}
      function render(){
        if(submitting||readOnly)return;
        const query=input.value.trim().toLocaleLowerCase();
        choices=records.filter(item=>searchable(item).toLocaleLowerCase().includes(query)).slice(0,30);active=-1;
        list.replaceChildren(...choices.map((item,index)=>{const option=el('button','contacts-lookup-option');option.type='button';option.tabIndex=-1;option.id=list.id+'-'+index;option.dataset.recordId=item.id;option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.setAttribute('aria-posinset',String(index+1));option.setAttribute('aria-setsize',String(choices.length));option.textContent=caption(item);option.addEventListener('mousedown',event=>event.preventDefault());option.addEventListener('click',()=>select(index));return option;}));
        if (describe) choices.forEach((item, index) => {
          if (choices.some((other, position) => position !== index && caption(other) === caption(item))) {
            const details = describe(item);
            list.children[index].title = details;
            list.children[index].setAttribute('aria-description', details);
          }
        });
        if(!choices.length){const empty=ui('p','helper',emptyText);empty.setAttribute('role','status');list.append(empty);}
        list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
      }
      input.addEventListener('focus',render);input.addEventListener('input',render);input.addEventListener('blur',hide);
      input.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&!list.hidden){hide();event.preventDefault();event.stopPropagation();return;}
        if(!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
        if(list.hidden&&event.key!=='Enter')render();
        if(list.hidden)return;
        event.preventDefault();if(event.key==='Enter'){if(active>=0)select(active);return;}
        if(!choices.length)return;
        active=active<0?(event.key==='ArrowDown'?0:choices.length-1):(active+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
        for(const [index,option]of [...list.children].entries())option.setAttribute('aria-selected',String(index===active));
        input.setAttribute('aria-activedescendant',list.id+'-'+active);list.children[active].scrollIntoView({block:'nearest'});
      });
      dialog.addEventListener('pointerdown',event=>{if(!box.contains(event.target))hide();});
    }
    if(!readOnly && ['leads','contacts'].includes(kind)) {
      const selectedAccount=directory.accounts.find(item=>item.id===accountId);if(selectedAccount)accountDefaults={abn_acn:selectedAccount.abn_acn||'',billing_address:selectedAccount.billing_address||''};
      fields.company.addEventListener('input',()=>{const account=directory.accounts.find(item=>item.id===accountId);if(!account || fields.company.value.trim()!==account.company){accountId='';for(const key of ['abn_acn','billing_address'])if(fields[key] && fields[key].value===accountDefaults[key])fields[key].value='';accountDefaults={};}});
      lookup(fields.company,directory.accounts,item=>[item.company,item.abn_acn].join(' '),item=>item.company,account=>accountSelection(account),'No matching Companies. You can enter a company name.');
    }
    let refreshComparison;
    if(!readOnly && kind==='leads') {
      let automaticStage = !record.id || record.status === 'New', pickedContact = false;
      function qualify() {
        if (automaticStage) fields.status.value = pickedContact || fields.phone.value.trim() || fields.email.value.trim() ? 'Qualified' : 'New';
      }
      fields.phone.addEventListener('input', qualify);
      fields.email.addEventListener('input', qualify);
      fields.status.addEventListener('change', () => { automaticStage = fields.status.value === 'New'; qualify(); });
      fields.name.addEventListener('input',()=>{if(fields.name.value.trim()!==contactName){contactId='';pickedContact=false;qualify();}});
      lookup(fields.name,directory.contacts,item=>[item.name,item.company,item.email,item.phone].join(' '),item=>item.name,contact=>{
        contactId=contact.id;contactName=contact.name;pickedContact=true;
        for(const key of ['name','phone','email','title'])fields[key].value=contact[key]||'';
        qualify();
        if(!fields.company.value.trim()){const account=directory.accounts.find(item=>item.id===contact.account_id);if(account)accountSelection(account);}
        refreshComparison?.();
      },'No matching Contacts. You can enter a name.', contact => [contact.company, contact.title, contact.email, contact.phone].filter(Boolean).join(' · '));
    }
    if (kind === 'leads' && record.id) {
      refreshComparison = window.ClassifireIdentity?.compare(form, fields, () => {
        const current = directory.identity_aliases?.contacts?.[contactId] || contactId;
        return directory.contacts.find(person=>person.id===current);
      }, () => {contactName=fields.name.value.trim();}, readOnly);
    }
    if (!readOnly) window.ClassifireIdentity?.suggestions(form,kind,fields,record,request,()=>contactId);
    const actions = el("div", "actions contacts-dialog-actions");
    const save = ui("button", "button primary", "Save");
    save.type = "submit";
    save.disabled = !linksReady;
    async function cancelModal() {
      if (submitting || timeline?.pending?.()) return;
      if(timeline?.dirty?.()){
        const before=JSON.stringify(timeline.fingerprint());
        if (!await window.CeasefireDialogs.confirm('Discard this activity?', '', 'Yes', 'Cancel') || !isOpen() || before!==JSON.stringify(timeline.fingerprint()))return;
      }
      closeEditor();
    }
    const cancel = button("Cancel", () => inPane ? leaveAccount() : cancelModal());
    copy(cancel, "Cancel");
    if (readOnly) {
      actions.append(button("Close", closeEditor));
    }
    else actions.append(cancel, save);
    const linkSelections = {};
    let linksChanged = () => false;
    if (kind === "accounts") {
      let supplementalRecords = {}, convertedLeads = [], activeLeads = [], participantProjects = [];
      const related = el("section", "contacts-related");
      const linkStatus = ui("p", "helper", "Loading linked records…");
      linkStatus.setAttribute("role", "status");
      const groups = el("div", "contacts-links");
      const findLabel = el("label", "field");
      if (window.CeasefireI18n) window.CeasefireI18n.nodeText(findLabel, "Find records to link");
      else findLabel.textContent = "Find records to link";
      const find = el("input");
      find.type = "search";
      find.placeholder = "Contact, project or document name…";
      window.CeasefireI18n?.attr(find, "placeholder", "Contact, project or document name…");
      find.disabled = readOnly;
      findLabel.append(find);
      const findBox = el("div", "contacts-link-search");
      const results = el("div", "contacts-link-search-results");
      results.id = heading.id + "-link-results";
      results.hidden = true;
      results.setAttribute("role", "group");
      results.setAttribute("aria-label", "Matching records");
      window.CeasefireI18n?.attr(results, "aria-label", "Matching records");
      find.setAttribute("aria-controls", results.id);
      find.setAttribute("aria-expanded", "false");
      findBox.append(findLabel, results);
      const findControls = el("div", "contacts-link-controls");
      const refresh = button("Refresh linked records", () => loadLinks(true));
      copy(refresh, "Refresh linked records");
      const unavailable = el("details", "contacts-link-errors");
      unavailable.hidden = true;
      const unavailableSummary = el("summary"), unavailableList = el("ul");
      unavailable.append(unavailableSummary, unavailableList);
      findControls.append(findBox, refresh);
      related.append(ui("h3", "", "Linked records"), findControls, linkStatus, unavailable, groups);
      form.append(related);
      const knownEntries = {}, searchEntries = {}, initialSelections = {}, automaticSelections = {}, explicitSelections = {}, explicitDeselections = {};
      linksChanged = () => Object.keys(linkSelections).some(key => {
        const initial = initialSelections[key], current = linkSelections[key];
        return initial && (initial.size !== current.size || [...initial].some(id => !current.has(id)));
      });
      let linkTicket = 0, searchTimer, searchOpen = false;
      function dismissResults() {
        searchOpen = false;
        results.hidden = true;
        find.setAttribute("aria-expanded", "false");
      }
      function selectedEntries(key) {
        return [...(linkSelections[key] || [])].map(id => knownEntries[key]?.get(id)).filter(Boolean)
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      function selectionChanged(key, item, checked, inSearch) {
        if (checked) linkSelections[key].add(item.id); else linkSelections[key].delete(item.id);
        if (checked) { explicitSelections[key].add(item.id); explicitDeselections[key].delete(item.id); }
        else { explicitSelections[key].delete(item.id); explicitDeselections[key].add(item.id); }
        renderLinked();
        renderResults(inSearch ? {key, id:item.id} : null);
        if (!inSearch) find.focus();
      }
      function recordRow(key, item, inSearch = false) {
        const row = el("li", "contacts-link-row"), label = el("label", "contacts-link-option");
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = linkSelections[key].has(item.id);
        checkbox.disabled = readOnly || Boolean(item.automatic);
        checkbox.dataset.linkKind = key;
        checkbox.dataset.linkTarget = item.id;
        checkbox.setAttribute("aria-label", "Link " + item.label);
        window.CeasefireI18n?.attr(checkbox, "aria-label", "Link {0}", [item.label]);
        checkbox.addEventListener("change", () => selectionChanged(key, item, checkbox.checked, inSearch));
        label.append(checkbox);
        row.append(label);
        const person = key === "contacts" && directory.contacts.find(contact => contact.id === item.id);
        if (!inSearch && person && !options.standalone) {
          row.append(button(person.name, async () => {
            if (!await leaveAccount()) return;
            closeEditor(); await switchPage("contacts"); dialogEditor("contacts", person);
          }, "text-button"));
        } else label.append(el("span", "", item.label));
        if (!inSearch && person) linkedSummary(row,[["Title",person.title],["Phone",person.phone],["Email",person.email]]);
        if (item.inherited) row.append(ui('p','helper','Linked through a merged record.'));
        else if (item.name_only) row.append(ui('p','helper','Matched by company name only.'));
        else if (item.supplier) row.append(ui("p", "helper", "Supplier"));
        else if (item.billing) row.append(ui('p','helper','Billing contact'));
        else if (item.automatic) row.append(ui("p", "helper", "Linked through this company's saved project."));
        else if (!item.available) row.append(ui("p", "helper", "Unavailable saved record. Clear the selection to remove this link."));
        else if (key === "contacts" && item.account_id && item.account_id !== record.id)
          row.append(ui("p", checkbox.checked ? "contacts-reassignment" : "helper", checkbox.checked ?
            "Saving will move this contact from {0}." : "Currently linked to {0}.", [item.account_label]));
        return row;
      }
      function renderLinked() {
        const expanded = new Set([...form.querySelectorAll("details[data-link-group][open]")].map(group => group.dataset.linkGroup));
        groups.replaceChildren();
        for (const [key, title] of Object.entries(linkTitles)) {
          const entries = selectedEntries(key);
          if (!entries.length) continue;
          const group = el("details", "contacts-links-group"), summary = el("summary");
          group.dataset.linkGroup = key;
          group.open = expanded.has(key);
          copy(summary, "{0} ({1})", [window.CeasefireI18n?.term(title) || title, entries.length]);
          const body = el("div", "contacts-links-body"), list = el("ul", "contacts-links-list");
          list.append(...entries.map(item => recordRow(key, item)));
          body.append(list); group.append(summary, body); groups.append(group);
        }
        for (const [key, title] of Object.entries({certifications:'Certification',swms:'SWMS'})) {
          const entries = supplementalRecords[key] || [];
          if (!entries.length) continue;
          const group=el('details','contacts-links-group'),summary=el('summary'),body=el('div','contacts-links-body'),list=el('ul','contacts-links-list');
          group.dataset.linkGroup=key;group.open=expanded.has(key);
          copy(summary,'{0} ({1})',[window.CeasefireI18n?.term(title)||title,entries.length]);
          for(const item of entries){const row=el('li','contacts-link-row');row.append(el('span','',item.label));list.append(row);}
          body.append(list);group.append(summary,body);groups.append(group);
        }
        appendLeadGroup(groups, 'leads', 'Leads', activeLeads, lead => {
          if (options.standalone) return el('span', '', lead.label);
          return button(lead.label, () => openDirectoryLead(lead.id), 'text-button');
        }, expanded.has('leads'));
        appendLeadGroup(groups, 'converted_leads', 'Converted leads', convertedLeads, conversionDetails, expanded.has('converted_leads'));
        appendLeadGroup(groups, 'participant_projects', 'Recorded project roles', participantProjects, participantProject, expanded.has('participant_projects'));
        if (!groups.children.length) groups.append(ui("p", "helper contacts-links-empty", "No linked records."));
        arrangeLinkedGroups(groups);
      }
      function renderResults(focusEntry = null) {
        const term = find.value.trim().toLocaleLowerCase();
        results.hidden = !searchOpen || !term || readOnly;
        find.setAttribute("aria-expanded", String(!results.hidden));
        results.replaceChildren();
        if (results.hidden) return;
        let count = 0;
        for (const [key, title] of Object.entries(linkTitles)) {
          const matching = [...(searchEntries[key]?.values() || [])].filter(item => item.available && item.label.toLocaleLowerCase().includes(term));
          matching.sort((a, b) => a.label.localeCompare(b.label));
          if (!matching.length) continue;
          const section = el("section", "contacts-link-search-group"), list = el("ul", "contacts-links-list");
          section.append(ui("h4", "", "{0} ({1})", [window.CeasefireI18n?.term(title) || title, matching.length]));
          list.append(...matching.slice(0, 100).map(item => recordRow(key, item, true)));
          section.append(list);
          if (matching.length > 100) section.append(ui("p", "helper", "Showing the first 100 records. Search to find another record."));
          results.append(section); count += matching.length;
        }
        if (!count) results.append(ui("p", "helper", "No matching records."));
        if (focusEntry) [...results.querySelectorAll("input")].find(input => input.dataset.linkKind === focusEntry.key && input.dataset.linkTarget === focusEntry.id)?.focus();
      }
      find.addEventListener("input", () => {
        searchOpen = true;
        renderResults();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadLinks(true), 250);
      });
      find.addEventListener("focus", () => { searchOpen = true; renderResults(); });
      find.addEventListener("keydown", event => {
        if (event.key === "Escape" && !results.hidden) { event.preventDefault(); event.stopPropagation(); dismissResults(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); searchOpen = true; renderResults();
          const inputs = [...results.querySelectorAll("input:not(:disabled)")];
          (event.key === "ArrowDown" ? inputs[0] : inputs.at(-1))?.focus();
        } else if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); searchOpen = true; loadLinks(true); }
      });
      results.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissResults(); find.focus(); dismissResults(); return; }
        const inputs = [...results.querySelectorAll("input:not(:disabled)")], index = inputs.indexOf(event.target);
        if (index < 0) return;
        const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (direction) { event.preventDefault(); inputs[(index + direction + inputs.length) % inputs.length]?.focus(); }
      });
      dialog.addEventListener("focusin", event => { if (!findBox.contains(event.target)) dismissResults(); });
      dialog.addEventListener("pointerdown", event => { if (!findBox.contains(event.target)) dismissResults(); });
      dialog.addEventListener("close", () => clearTimeout(searchTimer), {once: true});
      form.addEventListener("submit", () => clearTimeout(searchTimer));
      async function loadLinks(preserveSelection = false) {
        const ticket = ++linkTicket;
        loadingLinks = true;
        save.disabled = true;
        refresh.disabled = true;
        copy(linkStatus, "Loading linked records…");
        try {
          const query = new URLSearchParams();
          if (record.id) query.set("id", record.id);
          if (find.value.trim()) query.set("search", find.value.trim());
          const catalog = await request("account-links" + (query.size ? "?" + query : ""));
          if (!isOpen() || ticket !== linkTicket) return;
          supplementalRecords = catalog.related || {};
          convertedLeads = catalog.converted_leads || [];
          participantProjects = catalog.participant_projects || [];
          activeLeads = catalog.active_leads || [];
          for (const [key, title] of Object.entries(linkTitles)) {
            const linked = catalog.linked[key] || [], choices = catalog.choices[key] || [];
            const selected = preserveSelection && linkSelections[key] ? linkSelections[key] : new Set(linked.map(item => item.id));
            if (!explicitSelections[key]) explicitSelections[key] = new Set();
            if (!explicitDeselections[key]) explicitDeselections[key] = new Set();
            const currentLinked = new Set(linked.map(item => item.id));
            const currentAutomatic = new Set(linked.filter(item => item.automatic).map(item => item.id));
            // A prior automatic-only association is not a manual link request.
            // If its primary Account changed, retire it without inventing a
            // supplementary link. User-selected and persisted manual links stay.
            for (const id of automaticSelections[key] || []) if (!currentLinked.has(id) && !explicitSelections[key].has(id)) selected.delete(id);
            for (const id of explicitDeselections[key]) if (!currentAutomatic.has(id)) selected.delete(id);
            for (const item of linked) if (item.automatic) selected.add(item.id);
            automaticSelections[key] = new Set(linked.filter(item => item.automatic && !item.manual && !explicitSelections[key].has(item.id)).map(item => item.id));
            if (!initialSelections[key]) initialSelections[key] = new Set(linked.map(item => item.id));
            linkSelections[key] = selected;
            if (!knownEntries[key]) knownEntries[key] = new Map();
            for (const [id, item] of knownEntries[key]) if (item.automatic) knownEntries[key].set(id, {...item, automatic:false});
            for (const item of [...choices, ...linked]) knownEntries[key].set(item.id, item);
            searchEntries[key] = new Map([...choices, ...linked].map(item => [item.id, item]));
          }
          const focused = document.activeElement;
          const focusEntry = results.contains(focused) && focused.dataset.linkTarget ?
            {key:focused.dataset.linkKind, id:focused.dataset.linkTarget} : null;
          renderLinked(); renderResults(focusEntry);
          linksReady = true;
          save.disabled = false;
          unavailable.hidden = !catalog.error_count;
          copy(unavailableSummary, "Unavailable project records ({0})", [catalog.error_count || 0]);
          unavailableList.replaceChildren(...(catalog.errors || []).map(item => el("li", "", item.name)));
          copy(linkStatus, catalog.error_count ? "Some project records are unavailable. Current links are retained." :
            catalog.scan_pending ? "Project records are still loading. Refresh to list more records." :
            catalog.truncated ? "Search by name to find more records. Current links are retained." :
              "Select existing records to link to this company. Project links do not change the project details.");
        } catch (error) {
          if (!isOpen() || ticket !== linkTicket) return;
          linkStatus.textContent = error.message;
        } finally {
          if (ticket === linkTicket) {
            loadingLinks = false;
            refresh.disabled = submitting;
            save.disabled = submitting || !linksReady;
          }
        }
      }
      // The dialog must be open before a cached or very fast response is handled.
      queueMicrotask(loadLinks);
    }
    if (inPane && (kind === "contacts" || kind === "leads" && record.contact_id)) {
      const related = el("section", "contacts-related"), groups = el("div", "contacts-links");
      const linkStatus = ui("p", "helper", "Loading linked records…");
      linkStatus.setAttribute("role", "status");
      const refresh = button("Refresh linked records", () => loadContactLinks());
      contactLinkRefresh = refresh;
      copy(refresh, "Refresh linked records");
      const unavailable = el("details", "contacts-link-errors"), unavailableSummary = el("summary"), unavailableList = el("ul");
      unavailable.hidden = true; unavailable.append(unavailableSummary, unavailableList);
      related.append(ui("h3", "", "Linked records"), refresh, linkStatus, unavailable, groups); form.append(related);
      let contactLinkTicket = 0;
      async function loadContactLinks() {
        const ticket = ++contactLinkTicket;
        contactLinkLoading = true;
        refresh.disabled = true; copy(linkStatus, "Loading linked records…");
        try {
          const catalog = await request("contact-links?" + new URLSearchParams({id:kind === "leads" ? record.contact_id : record.id}));
          if (!isOpen() || ticket !== contactLinkTicket) return;
          const expanded = new Set([...form.querySelectorAll("details[data-link-group][open]")].map(group => group.dataset.linkGroup));
          const existing = new Set([...form.querySelectorAll("details[data-link-group]")].map(group => group.dataset.linkGroup));
          const groupOpen = key => expanded.has(key) || !existing.has(key);
          groups.replaceChildren();
          for (const [key, title] of Object.entries({companies:"Companies", projects:"Projects", leads:"Leads", quotes:"Quotes", work_orders:"Work Orders", purchase_orders:"Purchase Orders"})) {
            const entries = (catalog.linked[key] || []).filter(item=>kind !== "leads" || key !== "leads" || item.id !== record.id);
            if (!entries.length) continue;
            const group = el("details", "contacts-links-group"), summary = el("summary"), list = el("ul", "contacts-links-list");
            group.dataset.linkGroup = key; group.open = groupOpen(key);
            copy(summary, "{0} ({1})", [window.CeasefireI18n?.term(title) || title, entries.length]);
            for (const item of entries) {
              const row = el("li", "contacts-link-row");
              const company = key === "companies" && directory.accounts.find(account => account.id === item.id);
              if (company && item.available) row.append(button(item.label, async () => {
                if (!await leaveAccount()) return;
                await switchPage("accounts"); dialogEditor("accounts", company);
              }, "text-button"));
              else if(key==='leads' && item.available) row.append(button(item.label, () => openDirectoryLead(item.id), 'text-button'));
              else row.append(el("span", "", item.label));
              if(company)linkedSummary(row,[["Billing address",company.billing_address],["ABN/ACN",company.abn_acn]]);
              for (const role of item.roles || []) row.append(ui("p", "helper", role));
              list.append(row);
            }
            const body = el("div", "contacts-links-body"); body.append(list); group.append(summary, body); groups.append(group);
          }
          appendLeadGroup(groups, 'converted_leads', 'Converted leads', catalog.converted_leads || [], conversionDetails, groupOpen('converted_leads'));
          appendLeadGroup(groups, 'participant_projects', 'Recorded project roles', catalog.participant_projects || [], participantProject, groupOpen('participant_projects'));
          if (!groups.children.length) groups.append(ui("p", "helper contacts-links-empty", "No linked records."));
          arrangeLinkedGroups(groups);
          unavailable.hidden = !catalog.error_count;
          copy(unavailableSummary, "Unavailable project records ({0})", [catalog.error_count || 0]);
          unavailableList.replaceChildren(...(catalog.errors || []).map(item => el("li", "", item.name)));
          copy(linkStatus, catalog.error_count ? "Some project records are unavailable. Refresh to check the Contact's links." :
            catalog.scan_pending ? "Project records are still loading. Refresh to list more records." : "Saved records linked to this Contact are shown here.");
        } catch (error) {
          if (isOpen() && ticket === contactLinkTicket) linkStatus.textContent = error.message;
        } finally { if (isOpen() && ticket === contactLinkTicket) { contactLinkLoading = false; refresh.disabled = submitting; } }
      }
      queueMicrotask(loadContactLinks);
    }
    if (inPane && kind !== "leads") window.ClassifireIdentity?.management(form,kind,record,directory,request,async () => {
      closeEditor(); await activate(page);
    },()=>Object.keys(fields).some(key=>fields[key].value!==initialValues[key]) || linksChanged() || timeline?.dirty?.() || resources?.dirty?.() || resources?.pending?.());
    const timeline = record.id && window.ClassifireCrmActivity.attach(form,{
      kind,record,request,readOnly,staff,version:()=>version,setVersion:next=>{
        if(data?.version===version)data.version=next;
        if(directory.version===version)directory.version=next;
        version=next;
      },
      locked:()=>submitting||saving,isOpen
    });
    form.append(actions);
    // Keep Save as the default for Enter, even when a match is under review.
    const review = el('fieldset', 'contacts-group'), separate = ui('button', 'button secondary', 'Create a separate Contact');
    separate.type = 'submit';
    const separateLead = ui('button', 'button secondary', 'Keep as a separate Lead');
    separateLead.type = 'submit';
    review.hidden = true;
    let reviewedToken='',reviewedKind='';
    let identityReviews={};
    form.append(review);
    form.addEventListener('input', () => { review.hidden = true; identityReviews={}; });
    function reviewContacts(ids, decision) {
      const company = decision?.kind === 'accounts';
      reviewedToken = decision?.review_token || '';
      reviewedKind = decision?.kind || '';
      review.replaceChildren(ui('legend', '', company ? 'Use an existing Company' : 'Use an existing Contact'));
      const matchIds = new Set(ids);
      const candidates = directory[company?'accounts':'contacts'].filter(contact => matchIds.has(contact.id));
      for (const contact of candidates) {
        const label = [contact.name, contact.company, contact.title, contact.email, contact.phone].filter(Boolean).join(' · ');
        if (decision) {
          const reasons = decision.matches.find(item=>item.id===contact.id)?.reasons || [];
          const explanation = el('span','helper');
          reasons.forEach((reason,i)=>{if(i) explanation.append(', '); explanation.append(ui('span','',reason));});
          review.append(explanation);
        }
        review.append(button(label, () => {
          review.hidden = true;
          if (company && kind !== 'accounts') {
            accountSelection(contact); form.requestSubmit(save);
          } else if (kind === 'leads') {
            contactId = contact.id;
            contactName = fields.name.value.trim();
            form.requestSubmit(save);
          } else {
            savedRecord = contact;
            closeEditor();
            if (!options.standalone) void dialogEditor(company?'accounts':'contacts', contact);
          }
        }));
      }
      copy(separate, record.id ? 'Keep these records separate' : company ? 'Keep as a separate Company' : 'Create a separate Contact');
      review.append(separate);
      review.hidden = false;
      queueMicrotask(() => review.querySelector('button')?.focus());
    }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (readOnly || submitting || saving || loadingLinks || !linksReady || timeline?.pending?.()) return;
      if (resources?.pending?.() || resources?.dirty?.()) {feedback(form,{contacts:"Finish the current Contact action first.",accounts:"Finish the current Company action first.",leads:"Finish the current Lead action first."}[kind],true);return;}
      if (timeline?.dirty?.()){feedback(form,'Log or clear the activity first.',true);return;}
      if (newContact) {
        let first;
        for (const key of contactRequired) {
          const input = fields[key], missing = !meaningful(input.value);
          input.setCustomValidity(missing ? (window.CeasefireI18n?.translate?.('This field is required.') || 'This field is required.') : '');
          const invalid = !input.checkValidity();
          fieldErrors[key].hidden = !invalid;
          copy(fieldErrors[key], missing ? 'This field is required.' : 'Enter a valid email address.');
          if (invalid) {input.setAttribute('aria-invalid','true');first ||= input;}
          else input.removeAttribute('aria-invalid');
        }
        if (first) {feedback(form,'Complete Name, Phone, Company and Email before creating this Contact.',true);first.focus();return;}
      }
      submitting = saving = true;
      save.disabled = cancel.disabled = true;
      form.setAttribute("aria-busy", "true");
      const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
      const assignment = {owner_id:values.owner_id}; delete values.owner_id;
      // Region is retained in storage; this editor no longer changes it.
      const links = kind === "accounts" ? Object.fromEntries(Object.entries(linkSelections).map(([key, selected]) => [key, [...selected]])) : undefined;
      const editable = [...form.querySelectorAll("input,textarea,select,button")].filter(input => !input.disabled);
      editable.forEach(input => { input.disabled = true; });
      const createSeparate = !review.hidden && event.submitter === separate;
      if (createSeparate && reviewedKind) identityReviews[reviewedKind] = reviewedToken;
      const keepSeparateLead = !review.hidden && event.submitter === separateLead;
      review.hidden = true;
      try {
        if (kind === 'leads') {
          const companyKey = name => String(name || '').trim().replace(/\s+/g,' ').toLowerCase();
          const company = directory.accounts.find(item => accountId ? item.id === accountId : companyKey(item.company) === companyKey(values.company));
          const changed = !record.id || company?.id !== record.account_id || values.abn_acn !== record.abn_acn;
          if (changed && company?.abn_acn && values.abn_acn.trim() && company.abn_acn !== values.abn_acn.trim()) {
            if (await confirmDirectoryChange('ABN/ACN', company.company, company.abn_acn, values.abn_acn.trim())) {
              assignment.replace_company_abn = {id:company.id,expected:company.abn_acn};
            } else {
              fields.abn_acn.value = values.abn_acn = company.abn_acn;
            }
          }
        }
        const result = await request(kind, {id: record.id, fields: values, version, ...assignment, ...(kind==='leads'?{contact_id:contactId,account_id:accountId}:{}), ...(Object.keys(identityReviews).length ? {identity_reviews:identityReviews} : {}), ...(keepSeparateLead ? {keep_separate_lead:true} : {}), ...(links ? {links,identity_version:1} : {})});
        savedRecord = kind === "accounts" ? result.account : kind === 'contacts' ? result.contact : null;
        closeEditor();
        if (!options.standalone) await activate(page);
      }
      catch (error) {
        feedback(form, error.message, true);
        if (error.duplicateReview) reviewContacts(error.duplicateReview.matches.filter(item=>item.strong).map(item=>item.id),error.duplicateReview);
        else if (Array.isArray(error.matchingContacts)) reviewContacts(error.matchingContacts);
        else if (Array.isArray(error.matchingLeads)) {
          review.replaceChildren(ui('legend', '', 'Leads'));
          const ids = new Set(error.matchingLeads);
          for (const lead of directory.leads.filter(item => ids.has(item.id))) {
            review.append(el('span', '', [lead.name, lead.site_address, lead.description].filter(Boolean).join(' · ')));
          }
          review.append(separateLead); review.hidden = false;
          queueMicrotask(() => separateLead.focus());
        }
        else if (error.status === 409 && !options.standalone) dialog.addEventListener("close", () => activate(page), {once: true});
      }
      finally {
        submitting = saving = false;
        conversionBusy();
        editable.forEach(input => { input.disabled = false; });
        save.disabled = cancel.disabled = false;
        if (contactLinkRefresh && !contactLinkLoading) contactLinkRefresh.disabled = false;
        form.removeAttribute("aria-busy");
      }
    });
    dialog.append(form);
    dialog.addEventListener("cancel", event => {
      if(submitting || timeline?.pending?.())event.preventDefault();
      else if(timeline?.dirty?.()){event.preventDefault();void cancelModal();}
    });
    dialog.addEventListener("close", () => {
      if (inPane && accountEditor?.element === dialog) {
        accountEditor = null;
        dialog.parentNode?.classList.remove("contacts-account-open");
        const list=dialog.parentNode?.querySelector(".contacts-workspace");if(list)list.hidden=false;
        resources?.close?.();
      }
      dialog.remove(); resolveClosed(savedRecord);
      if ((inPane || options.standalone) && returnFocus?.isConnected) returnFocus.focus();
    }, {once: true});
    if (inPane) {
      const close = button("←", () => leaveAccount(), "button secondary icon-only contacts-account-close");
      const backLabel={accounts:"Back to Companies",contacts:"Back to Contacts",leads:"Back to Leads"}[kind];
      close.setAttribute("aria-label",backLabel);close.title=backLabel;
      window.CeasefireI18n?.attr(close,"aria-label",backLabel);window.CeasefireI18n?.attr(close,"title",backLabel);
      dialog.classList.add("contacts-record-workspace");
      const columns=el("div","contacts-record-layout"),main=el("div","contacts-record-main"),details=el("section","card contacts-record-details");
      workspaceLeft=el("aside","commercial-sidebar contacts-record-left");workspaceRight=el("aside","commercial-sidebar contacts-record-right");
      associationPanel=el("details","card commercial-side-panel");associationPanel.open=true;
      associationLinks=el("div","contacts-record-associations");workspaceLeft.append(associationPanel,associationLinks);
      if(kind === "leads" && record.contact_id) {
        const person=directory.contacts.find(item=>item.id===record.contact_id);
        if(person) {
          const linkedContact=el("details","card commercial-side-panel"),body=el("article","commercial-linked-contact");linkedContact.open=true;
          body.append(button(person.name,()=>void openAssociation("contacts",person.id),"text-button project-title-button"));
          linkedSummary(body,[["Title",person.title],["Phone",person.phone],["Email",person.email]]);
          linkedContact.append(ui("summary","","Linked Contacts"),body);workspaceLeft.append(linkedContact);
        }
      }
      const toolbar=el("div","commercial-editor-actions contacts-record-toolbar");toolbar.append(close);
      if(!readOnly)toolbar.append(save);
      const originalChildren=[...form.children];
      for(const child of originalChildren) {
        if(child.matches(".contacts-related,.crm-identity-section,.crm-timeline"))workspaceRight.append(child);
        else details.append(child);
      }
      main.append(toolbar,details);columns.append(workspaceLeft,main,workspaceRight);form.append(columns);
      showAssociation();
      form.addEventListener("input",showAssociation);
      for(const groups of form.querySelectorAll(".contacts-links"))arrangeLinkedGroups(groups);
      const resourceHost=el("div","contacts-record-resources");workspaceRight.prepend(resourceHost);
      accountEditor = {element:dialog, kind, close:closeEditor, pending:()=>submitting || timeline?.pending?.() || resources?.pending?.(),
        pendingMessage:()=>({contacts:"Finish the current Contact action first.",accounts:"Finish the current Company action first.",leads:"Finish the current Lead action first."}[kind]),
        dirty:()=>Object.keys(fields).some(key=>fields[key].value !== initialValues[key]) || linksChanged() || timeline?.dirty?.() || resources?.dirty?.(),
        fingerprint:()=>JSON.stringify({id:record.id,version,fields:Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.value])),links:Object.fromEntries(Object.entries(linkSelections).map(([key,selected])=>[key,[...selected].sort()])),activity:timeline?.fingerprint?.(),resources:resources?.fingerprint?.()}),
        notice:(message,error)=>feedback(form,message,error)};
      const layout = root().querySelector(".contacts-directory-layout");
      layout.classList.add("contacts-account-open");layout.querySelector(".contacts-workspace").hidden=true;layout.prepend(dialog);
      resources=window.ClassifireRecordResources?.attach(resourceHost,{owner:{kind,id:record.id},isCurrent:isOpen,
        canEdit:()=>!readOnly&&!submitting&&!saving,message:(message,error)=>feedback(form,message,error)});
      dialog.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.target.closest("details[open]")) return;
        event.preventDefault(); event.stopPropagation(); void leaveAccount();
      });
      (kind === "accounts" ? fields.company : fields.name).focus();
    } else {
      (options.standalone ? document.body : root()).append(dialog);
      dialog.showModal();
    }
    return closed;
  }
  async function createAccount(options = {}) {
    const directory = await request("directory");
    return dialogEditor("accounts", {company: typeof options.company === "string" ? options.company : ""}, {directory, standalone: true, isCurrent:options.isCurrent});
  }
  async function createContact(initial = {}) {
    const directory = await request('directory');
    const accountId = directory.identity_aliases?.accounts?.[initial.account_id] || initial.account_id;
    const account = accountId ? directory.accounts.find(item => item.id === accountId) : null;
    if(initial.account_id && !account)throw new Error('Choose a valid Company.');
    return dialogEditor('contacts',{name:typeof initial.name==='string'?initial.name:'',...(account?{company:account.company,account_id:account.id}:{})},{directory,standalone:true,isCurrent:initial.isCurrent});
  }
  async function editContact(id, options = {}) {
    await window.ClassifireAccess?.ready;
    const directory = await request('directory');
    if (options.isCurrent && !options.isCurrent()) return null;
    const contact = directory.contacts.find(person=>person.id===id);
    if (!contact) throw new Error('The selected directory record is unavailable.');
    const readOnly = Boolean(window.ClassifireAccess && !window.ClassifireAccess.can('edit'));
    return dialogEditor('contacts',contact,{directory,standalone:true,lockedReadOnly:readOnly,isCurrent:options.isCurrent});
  }
  async function editAccount(id, options = {}) {
    await window.ClassifireAccess?.ready;
    const directory = await request('directory');
    if (options.isCurrent && !options.isCurrent()) return null;
    const account = directory.accounts.find(company=>company.id===id);
    if (!account) throw new Error('The selected directory record is unavailable.');
    const readOnly = Boolean(window.ClassifireAccess && !window.ClassifireAccess.can('edit'));
    return dialogEditor('accounts',account,{directory,standalone:true,lockedReadOnly:readOnly,isCurrent:options.isCurrent});
  }
  function matches(row) {
    const keys = page === "accounts" ? ["company", "abn_acn", "billing_address", "owner_name"] :
      page === "leads" ? [...personFields, "abn_acn", "status", "site_address", "billing_address", "description", "next_action", "follow_up_date","owner_name","region","project_no"] : [...personFields,"owner_name"];
    if (page === "leads" && followUpBy && (!row.follow_up_date || row.follow_up_date > followUpBy)) return false;
    return keys.some(key => (row[key] || "").toLowerCase().includes(search.trim().toLowerCase()));
  }
  async function moveLead(lead, status) {
    if (status === 'New' && (lead.phone || lead.email)) status = 'Qualified';
    if (lead.status === status || saving) return;
    if (status === 'Converted') { await convertLead(lead); return; }
    const fields = Object.fromEntries([...personFields, "abn_acn", "site_address", "billing_address", "description"].map(key => [key, lead[key]]));
    try { await update("leads", {id: lead.id, version: data.version, contact_id:lead.contact_id,account_id:lead.account_id,fields: {...fields, status}}); }
    catch (error) { feedback(root(), error.message, true); }
  }
  function conversionBusy(){for(const button of root().querySelectorAll('[data-lead-convert]')){button.disabled=saving||Boolean(converting);button.setAttribute('aria-busy',String(converting===button.dataset.leadConvert));}}
  async function convertLead(lead){
    if(saving||converting)return;
    if(['name','phone','company','email','site_address'].some(key=>typeof lead[key]!=='string'||!lead[key].trim())){
      feedback(root(),'Complete Name, Phone, Company, Email and Site address before converting this Lead.',true);
      return;
    }
    converting=lead.id;conversionBusy();
    try{const saved=await update('leads/convert',{id:lead.id,version:data.version});if(saved)await window.CeasefireProject?.openConvertedLead(saved);}
    catch(error){if(root().querySelector('[data-contacts-notice]'))feedback(root(),error.message,true);}
    finally{converting=null;conversionBusy();}
  }
  function refreshFollowUps() {
    window.clearTimeout(followUpTimer);
    const board = root()?.querySelector('.contacts-board');
    if (!board || board.closest('[hidden]') || document.hidden || !board.querySelector('[data-follow-up-date]')) return;
    const today = window.CeasefireScheduler.organizationToday();
    if (board.dataset.followUpDay !== today) {
      for (const marker of board.querySelectorAll('[data-follow-up-date]')) marker.hidden = marker.dataset.followUpDate > today;
      board.dataset.followUpDay = today;
    }
    // The next minute boundary also catches local midnight when the UTC offset changes.
    followUpTimer = window.setTimeout(refreshFollowUps, 60000 - Date.now() % 60000);
  }
  function leadBoard(rows) {
    const board = el("div", "project-kanban contacts-board");
    for (const status of data.statuses) {
      const column = el("section", "project-kanban-column");
      column.dataset.status = status;
      // ISO calendar dates sort chronologically. Keep the existing directory
      // order for equal dates and put unscheduled leads after dated follow-ups.
      const group = rows.filter(lead => lead.status === status).sort((a,b) =>
        (a.follow_up_date || "99999").localeCompare(b.follow_up_date || "99999"));
      const heading = el("div", "project-column-heading");
      heading.append(ui("h2", "", status), el("span", "badge", group.length));
      column.append(heading);
      for (const lead of group) {
        const card = el("article", "project-kanban-card");
        if (lead.follow_up_date) {
          const marker = el('span', 'contacts-follow-up-due', '!');
          marker.hidden = true;
          marker.dataset.followUpDate = lead.follow_up_date;
          marker.setAttribute('role', 'img');
          marker.setAttribute('aria-label', 'Follow-up due');
          marker.title = 'Follow-up due';
          window.CeasefireI18n?.attr(marker, 'aria-label', 'Follow-up due');
          window.CeasefireI18n?.attr(marker, 'title', 'Follow-up due');
          card.append(marker);
        }
        if (status === 'Converted') {
          if (lead.name) card.append(el('strong', 'project-card-heading', lead.name));
          card.append(conversionDetails(lead.receipt, true));
          column.append(card);
          continue;
        }
        card.draggable = true;
        card.addEventListener("dragstart", event => {
          if(saving||converting||event.target.closest('button,summary,input,select')){event.preventDefault();return;}
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-classifire-lead", lead.id);
        });
        const row = el("div", "project-card-heading"), menu = el("details", "commercial-card-menu contacts-lead-menu");
        const toggle = el("summary", "", "▾");
        toggle.setAttribute("aria-label", `Actions for ${lead.name}`);
        const options = el("div", "commercial-menu-options");
        for (const name of ["Open", "Edit"]) {
          options.append(button(name, () => {menu.open = false; dialogEditor("leads", lead);}, "text-button"));
        }
        const convertMenu=button('Convert',()=>{menu.open=false;void convertLead(lead);},'text-button');convertMenu.dataset.leadConvert=lead.id;options.append(convertMenu);
        menu.append(toggle, options);
        menu.addEventListener("toggle", () => {
          if (!menu.open) return;
          const rect = toggle.getBoundingClientRect();
          options.style.left = `${Math.max(8, Math.min(innerWidth - options.offsetWidth - 8, rect.right - options.offsetWidth))}px`;
          options.style.top = `${rect.bottom + options.offsetHeight + 12 <= innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - options.offsetHeight - 6)}px`;
        });
        row.append(button(lead.name, () => dialogEditor("leads", lead), "text-button project-title-button"), menu);
        card.append(row);
        const details = el("dl", "kanban-card-details");
        for (const key of ["company", "site_address", "region", "owner_name", "title", "phone", "email", "next_action", "follow_up_date","last_interaction_at"]) {
          if (!lead[key] && key !== "company") continue;
          details.append(ui("dt", "", labels[key]), el("dd", "", key==='last_interaction_at'?new Date(lead[key]).toLocaleString():lead[key] || "—"));
        }
        card.append(details);
        const actions=el('div','contacts-lead-actions'),convert=button('',()=>void convertLead(lead),'button primary icon-only contacts-lead-convert takeoff-preview-transfer');
        convert.dataset.leadConvert=lead.id;convert.title='Convert';convert.setAttribute('aria-label','Convert lead '+lead.name);
        window.CeasefireI18n?.attr(convert,'title','Convert');window.CeasefireI18n?.attr(convert,'aria-label','Convert lead {0}',[lead.name]);
        const symbol=el('img','takeoff-transfer-icon');symbol.src='/icons/takeoff-transfer.png';symbol.alt='';symbol.width=symbol.height=24;symbol.setAttribute('aria-hidden','true');convert.append(symbol);actions.append(convert);card.append(actions);
        column.append(card);
      }
      if (!group.length) column.append(el("p", "project-column-empty", "No leads"));
      column.addEventListener("dragover", event => {
        if (event.dataTransfer.types.includes("application/x-classifire-lead")) event.preventDefault();
      });
      column.addEventListener("drop", event => {
        event.preventDefault();
        const lead = data.leads.find(row => row.id === event.dataTransfer.getData("application/x-classifire-lead"));
        if (lead) moveLead(lead, status);
      });
      board.append(column);
    }
    return board;
  }
  function directoryTable(rows) {
    const keys = page === "accounts" ? ["company", "abn_acn", "billing_address"] : ["name", "company", "title", "phone", "email"];
    const wrapper = el("div", "table-scroll");
    const table = el("table", "contacts-table");
    const header = table.createTHead().insertRow();
    for (const key of keys) header.append(el("th", "", labels[key]));
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const [index, key] of keys.entries()) {
        const cell = tr.insertCell();
        if (index === 0) cell.append(button(row[key], () => dialogEditor(page, row), "text-button"));
        else cell.textContent = row[key] || "—";
      }
    }
    wrapper.append(table);
    if (!rows.length) wrapper.append(page === "accounts" ? ui("p", "helper", "No matching companies.") : el("p", "helper", "No matching " + titles[page].toLowerCase() + "."));
    return wrapper;
  }
  function displayRows() {
    const host = root().querySelector(".contacts-results");
    if (page === 'leads') {
      const converted = (data.converted_leads || []).map(receipt => ({
        ...receipt.snapshot, id: receipt.lead_id, project_no: receipt.project_no, status: 'Converted', receipt
      }));
      host.replaceChildren(leadBoard([...data.leads, ...converted].filter(matches)));
    } else host.replaceChildren(directoryTable(data[page].filter(matches)));
    refreshFollowUps();
    conversionBusy();
  }
  function documentMenu(kind) {
    const menu = el("details", "calculator-document-menu contacts-document");
    const toggle = el("summary", "button secondary calculator-document-toggle"), icon = el("img", "calculator-document-icon");
    icon.src = "/icons/document.png"; icon.alt = ""; icon.width = icon.height = 24;
    toggle.append(icon, "Document", document.querySelector("#calculator-document-toggle .calculator-document-chevron").cloneNode(true));
    menu.append(toggle);
    const options = el("div", "calculator-document-actions");
    function fileLabel(arrow, label) {
      const symbol = el("span", "download-format-icon");
      symbol.setAttribute("aria-hidden", "true");
      symbol.append(el("span", "download-arrow", arrow), el("span", "download-format", "XLSX"));
      return [symbol, el("span", "", label)];
    }
    const file = el("input");
    file.type = "file"; file.accept = ".xlsx"; file.hidden = true;
    const download = el("a", "button excel-button calculator-document-action");
    download.append(...fileLabel("⇩", "Export Template"));
    download.href = `/api/contacts/${kind}/template.xlsx`;
    download.download = "";
    download.addEventListener("click", () => { menu.open = false; });
    const upload = button("", () => {menu.open = false; file.click();}, "button excel-button calculator-document-action");
    upload.append(...fileLabel("⇧", "Import Template"));
    options.append(upload, download);
    file.addEventListener("change", async () => {
      const selected = file.files[0];
      const version = data.version;
      if (!selected) return;
      try {
        if (!selected.size || selected.size > 5 * 1024 * 1024) throw new Error("Choose an Excel workbook up to 5 MB.");
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(reader.result.split(",")[1]));
          reader.addEventListener("error", () => reject(new Error("The file could not be read.")));
          reader.readAsDataURL(selected);
        });
        await update(kind + "/import", {version, filename: selected.name, file: encoded});
      } catch (error) { feedback(root(), error.message, true); }
      finally { file.value = ""; }
    });
    menu.append(options, file);
    return menu;
  }
  async function switchPage(kind) {
    if (kind === 'leads' && !data.converted_leads) return activate(kind);
    if (!await leaveAccount()) return false;
    page = kind;
    search = "";
    render();
  }
  function render() {
    const container = root();
    container.replaceChildren();
    const heading = el("div", "page-heading");
    const title = el("div");
    title.append(el("p", "eyebrow", "CONTACTS"), page === "accounts" ? ui("h1", "", titles[page]) : el("h1", "", titles[page]));
    heading.append(title);
    const tabs = el("nav", "calculator-pages contacts-tabs");
    tabs.setAttribute("aria-label", "Contacts pages");
    for (const [key, label] of Object.entries(titles)) {
      const tab = button(label, () => switchPage(key), "calculator-page");
      if (key === "accounts") copy(tab, label);
      tab.setAttribute("aria-pressed", String(key === page));
      if (key === page) tab.setAttribute("aria-current", "page");
      tabs.append(tab);
    }
    for (const choice of document.querySelectorAll("#contacts-navigation-menu [data-contacts-section]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.contactsSection === page));
    }
    const section = el("section", "card contacts-workspace");
    const controls = el("div", "contacts-controls");
    const searchLabel = el("label", "field");
    const searchTitle = "Search " + titles[page].toLowerCase();
    if (page === "accounts" && window.CeasefireI18n) window.CeasefireI18n.nodeText(searchLabel, searchTitle);
    else searchLabel.textContent = searchTitle;
    const input = el("input");
    input.type = "search"; input.value = search;
    input.addEventListener("input", () => { search = input.value; displayRows(); });
    searchLabel.append(input);
    controls.append(searchLabel);
    if (page === "leads") {
      const label = el("label", "field");
      if (window.CeasefireI18n) window.CeasefireI18n.nodeText(label, "Follow up by");
      else label.textContent = "Follow up by";
      const cutoff = el("input"); cutoff.type = "date"; cutoff.value = followUpBy;
      cutoff.addEventListener("input", () => { followUpBy = cutoff.value; displayRows(); });
      label.append(cutoff); controls.append(label);
    }
    if (page !== "leads") controls.append(documentMenu(page));
    const create = creationButton("New " + singular[page], () => dialogEditor(page));
    controls.append(create);
    section.append(controls, el("div", "contacts-results"));
    const layout = el("div", "contacts-directory-layout");
    layout.append(section);
    container.append(heading, tabs, notice(), layout);
    displayRows();
    conversionBusy();
  }
  document.addEventListener("click", event => {
    root()?.querySelectorAll(".contacts-document[open],.contacts-lead-menu[open]").forEach(menu => {if (!menu.contains(event.target)) menu.open = false;});
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menu = event.target.closest?.("#contacts-root details[open]");
    if (menu) {menu.open = false; menu.querySelector("summary").focus();}
  });
  document.addEventListener('visibilitychange', refreshFollowUps);
  window.addEventListener('pageshow', refreshFollowUps);
  window.addEventListener('ceasefire:organization-timezone-changed', refreshFollowUps);
  window.ClassifireContacts = {activate, createAccount, createContact, editContact, editAccount, confirmDirectoryChange, leave:leaveAccount,
    pendingMessage:()=>accountEditor?.pendingMessage() || "Finish the current Company action first.",
    hasUnsavedChanges:()=>Boolean(accountEditor?.dirty()), hasPendingOperation:()=>Boolean(accountEditor?.pending()),
    fingerprint:()=>accountEditor?.fingerprint() || ""};
})();
