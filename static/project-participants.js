(() => {
  "use strict";
  const pane = document.getElementById("project-details-pane");
  if (!pane) return;
  const hosts = {
    accounts: document.getElementById("project-company-participants"),
    contacts: document.getElementById("project-contact-participants")
  };
  function el(tag, value) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function text(node, value) {
    node.textContent = value;
    window.CeasefireI18n?.text(node, value);
    return node;
  }
  function ui(tag, value) { return text(el(tag), value); }
  function status() {
    const note = el("p");
    note.className = "helper project-link-status";
    note.setAttribute("role", "status");
    return note;
  }
  const sites = el("details"), projects = el("div"), siteStatus = status();
  sites.id = "project-participants-panel";
  sites.className = "card commercial-side-panel";
  sites.hidden = true;
  sites.open = true;
  sites.append(ui("summary", "Linked Projects"), projects, siteStatus);
  document.getElementById("project-pricing-notice").before(sites);

  let selection = null, fileRevision = null, record = null, generation = 0, directory = {accounts:[],contacts:[]}, roleSelection = {};
  let saving = false, loading = false, scanTimer, retriedScan = false;
  let history = null, projectOwner = null;
  const canEdit = () => !window.ClassifireAccess || window.ClassifireAccess.can("edit");

  async function api(path, data) {
    const options = data === undefined ? {cache: "no-store"} : {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)
    };
    const response = await fetch("/api/" + path, options);
    const value = await response.json();
    if (!response.ok) {
      const error = Error(value.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return value;
  }

  function showProjects(data) {
    const list = el("ul"), seen = new Set();
    for (const bid of [...data.linked_bids, ...(data.other_site_bids || [])]) {
      if (bid.source) {
        const key = JSON.stringify([bid.source, bid.owner || ""]);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const row = el("li"), label = [bid.project_no, bid.client, bid.site_address].filter(Boolean).join(" · ");
      if (bid.availability === "available" && bid.source) {
        const open = el("button", label);
        open.type = "button"; open.className = "text-button";
        open.onclick = () => void window.CeasefireProject.openLinkedProject(bid, open);
        row.append(open);
      } else row.textContent = label;
      if (bid.availability === "unavailable") row.append(" · ", ui("small", "Saved project unavailable"));
      if (bid.availability === "unverified") row.append(" · ", ui("small", "Availability not yet verified"));
      list.append(row);
    }
    projects.replaceChildren();
    if (list.childElementCount) projects.append(list);
    else if (!data.scan_pending && !data.error_count) projects.append(ui("p", "No linked projects."));
    const partial = data.error_count || data.scan_pending && retriedScan;
    text(siteStatus, partial ? "Some linked projects could not be checked." : data.scan_pending ? "Loading…" : "");
    clearTimeout(scanTimer);
    if (data.scan_pending && sites.open && !retriedScan) scanTimer = setTimeout(() => {
      if (sites.getClientRects().length && sites.open) { retriedScan = true; void load(); }
    }, 600);
  }

  function lockParticipants(value) {
    for (const host of Object.values(hosts)) host.querySelectorAll("fieldset").forEach(node => { node.disabled = value; });
  }

  async function readRecord(checkRevision = true) {
    const data = await api("crm/project-participants?project=" + encodeURIComponent(selection));
    if ((projectOwner && data.project_owner !== projectOwner) || (checkRevision && fileRevision && data.project_revision !== fileRevision)) throw Error("The project changed. Reopen its details before changing participants.");
    return data;
  }

  async function save(rows, host, removed) {
    if (saving || !record || !canEdit()) return;
    if (fileRevision && record.project_revision !== fileRevision) {
      text(host.querySelector('[role="status"]'), "The project changed. Reopen its details before changing participants.");
      return;
    }
    const ticket = generation;
    clearTimeout(scanTimer);
    saving = true;
    lockParticipants(true);
    try {
      const data = await api("crm/project-participants", {
        project: selection, project_revision: record.project_revision, version: record.version,
        participants: rows.map(({role, kind, id}) => ({role, kind, id})), site_id: record.site_id,
        ...(removed ? {remove_party:removed} : {})
      });
      if (ticket !== generation) return;
      record = data;
      renderParticipants();
      showProjects(data);
      void history?.refresh();
    } catch (error) {
      if (ticket !== generation) return;
      let message = error.message;
      if (error.status === 409) {
        try {
          const latest = await readRecord();
          if (ticket !== generation) return;
          record = latest;
          renderParticipants();
          showProjects(latest);
          message = "Participants changed. Review the updated list and try again.";
        } catch (refreshError) { message = refreshError.message; }
      }
      if (ticket === generation) text(host.querySelector('[role="status"]'), message);
    } finally {
      if (ticket === generation) { saving = false; lockParticipants(false); }
    }
  }

  function renderParticipants() {
    const companyIds = new Set([...record.participants, ...(record.linked_parties || [])]
      .filter(item => item.kind === "accounts").map(item => item.id));
    for (const [kind, host] of Object.entries(hosts)) {
      window.ClassifireCrmActivity.stopSizing(host.querySelector('.project-party-cards'));
      host.replaceChildren();
      const entries = record.participants.filter(item => item.kind === kind);
      const group = el("fieldset"), note = status();
      const aliases = directory.identity_aliases?.[kind] || {};
      const canonicalId = id => aliases[id] || id;
      const primaryId = canonicalId(window.CeasefireProjectPane?.primaryParties()[kind]);
      const isPrimary = item => canonicalId(item.id) === primaryId;
      const recorded = new Set(entries.map(item => canonicalId(item.id)));
      const linked = new Map();
      for (const item of record.linked_parties || []) {
        if (item.kind !== kind || isPrimary(item) || recorded.has(canonicalId(item.id))) continue;
        const previous = linked.get(item.id);
        if (previous) { previous.roles.add(item.role); previous.label ||= item.label; }
        else linked.set(item.id, {label: item.label, roles: new Set([item.role])});
      }
      const primary = partyItem(kind,primaryId);
      const primaryRole = kind === "accounts" ? "Main Client" : "Primary contact";
      if (entries.length || linked.size || primary) {
        const list = el("ul");
        list.className = "project-party-cards";
        if (primary && !recorded.has(primaryId)) {
          const row = el("li");
          row.append(partyCard(kind, primaryId, kind === "accounts" ? primary.company : primary.name,
            [primaryRole], host));
          list.append(row);
        }
        const ordered = [...entries.filter(isPrimary), ...entries.filter(item => !isPrimary(item))];
        for (const item of ordered) {
          const row = el("li");
          const role = record.roles[item.role] || item.role;
          const card = partyCard(kind, item.id, item.label, isPrimary(item) ? [primaryRole, role] : [role], host);
          if (canEdit()) {
            const remove = ui("button", "Remove");
            remove.type = "button"; remove.className = "text-button";
            remove.onclick = () => {
              const rows = record.participants.filter(entry => entry.kind !== kind || entry.id !== item.id || entry.role !== item.role);
              void save(rows, host, rows.some(entry => entry.kind === kind && entry.id === item.id) ? null : {kind,id:item.id});
            };
            card.append(remove);
          }
          row.append(card);
          list.append(row);
        }
        for (const [id,{label, roles}] of linked) {
          const row = el("li");
          const card = partyCard(kind, id, label, [...roles], host);
          if (canEdit()) {
            const remove = ui("button", "Remove");
            remove.type = "button"; remove.className = "text-button";
            remove.onclick = () => void save(record.participants, host, {kind,id});
            card.append(remove);
          }
          row.append(card);
          list.append(row);
        }
        group.append(list);
      }
      if (canEdit()) {
        const role = el("select"), label = ui("label", "Role");
        const labelId = kind === "accounts" ? "Company" : "Contact";
        role.id = "project-participant-role-" + kind;
        label.htmlFor = role.id;
        for (const [key, name] of Object.entries(record.roles)) {
          const option = ui("option", name); option.value = key; role.append(option);
        }
        if (kind === "contacts") role.value = "site_contact";
        if (roleSelection[kind] && Object.hasOwn(record.roles,roleSelection[kind])) role.value = roleSelection[kind];
        role.addEventListener("change",()=>{roleSelection[kind] = role.value;});
        const field = el("div"); field.className = "field"; field.append(label, role);
        const search = window.ClassifireCommercialDirectory.field(labelId, {
          kind, isCurrent: () => !!selection && !saving && canEdit() && !host.inert && !pane.inert,
          account: () => ({id: window.CeasefireProjectPane.primaryParties().accounts}),
          read: () => "", onInput() {}, message: value => text(note, value),
          filter: (item, directory) => (kind !== "contacts" || contactCompanyIsLinked(item, directory, companyIds)) &&
            !entries.some(entry => entry.id === item.id && entry.role === role.value),
          onSelect: item => void save([...record.participants, {role: role.value, kind, id: item.id}], host)
        });
        group.prepend(field, search.element);
      }
      if (group.childElementCount) host.append(group, note);
      host.closest("details").hidden = !group.childElementCount;
      const list = group.querySelector('.project-party-cards');
      if (list) {
        const heading = host.closest('details').querySelector('summary');
        heading.id = host.id + '-heading';
        window.ClassifireCrmActivity.sizeList(list, 1, heading);
      }
    }
  }

  function partyItem(kind,id) {
    const canonical = directory.identity_aliases?.[kind]?.[id] || id;
    return directory[kind]?.find(item => item.id === canonical);
  }

  function partyCard(kind, id, name, roles, host) {
    const item = partyItem(kind,id), card = el("article");
    card.className = kind === "accounts" ? "commercial-linked-company" : "commercial-linked-contact";
    card.dataset[kind === "accounts" ? "accountId" : "contactId"] = id;
    const label = item ? (kind === "accounts" ? item.company : item.name) : name;
    if (item) {
      const open = el("button", label); open.type = "button"; open.className = "text-button project-title-button";
      const opened = generation;
      open.onclick = async () => {
        const current = () => opened === generation && !!selection && !saving && !pane.inert && !host.inert && host.isConnected;
        if (!current()) return;
        open.disabled = true;
        try {
          await window.ClassifireContacts[kind === "accounts" ? "editAccount" : "editContact"](item.id,{isCurrent:current});
          if (current()) await refreshDirectory(opened);
        } catch (error) { if (current()) text(host.querySelector('[role="status"]'), error.message); }
        finally { if (open.isConnected) open.disabled = false; }
      };
      card.append(open);
    } else card.append(el("strong", label));
    const role = el("p"); role.className = "helper";
    roles.forEach((name,index) => {if(index)role.append(" · ");role.append(ui("span",name));}); card.append(role);
    const values = kind === "accounts" ? [["Billing address",item?.billing_address],["ABN/ACN",item?.abn_acn]]
      : [["Title",item?.title],["Phone",item?.phone],["Email",item?.email]];
    const details = el("dl"); details.className = "commercial-card-info";
    for (const [label,value] of values) details.append(ui("dt",label),el("dd",value || "—"));
    card.append(details); return card;
  }

  async function refreshDirectory(opened = generation) {
    try {
      const latest = await window.ClassifireCommercialDirectory.load(true);
      if (opened !== generation || !selection) return;
      directory = latest; if (record) renderParticipants();
    } catch (error) { if (opened === generation && selection) text(siteStatus,error.message); }
  }

  function contactCompanyIsLinked(contact, directory, linked) {
    if (!contact.account_id) return false;
    const aliases = directory.identity_aliases?.accounts || {};
    const canonical = id => aliases[id] || id;
    const company = canonical(contact.account_id);
    const main = window.CeasefireProjectPane?.primaryParties().accounts;
    if (company === canonical(main) || linked.has(company)) return true;
    return Object.entries(aliases).some(([alias, id]) => id === company && linked.has(alias));
  }

  async function load() {
    if (!selection || loading || saving) return;
    const ticket = generation, previous = record;
    loading = true;
    try {
      await window.ClassifireAccess?.ready;
      if (ticket !== generation) return;
      const [data, latest] = await Promise.all([readRecord(), window.ClassifireCommercialDirectory.load().catch(()=>null)]);
      if (ticket !== generation || saving || record !== previous) return;
      if (latest) directory = latest;
      record = data;
      if (!previous || previous.version !== data.version) renderParticipants();
      showProjects(data);
    } catch (error) {
      if (ticket === generation) text(siteStatus, error.message);
    } finally {
      if (ticket === generation) loading = false;
    }
  }

  function close() {
    ++generation;
    for (const host of Object.values(hosts)) window.ClassifireCrmActivity.stopSizing(host.querySelector('.project-party-cards'));
    history?.dispose(); history?.element.remove(); history = null;
    clearTimeout(scanTimer);
    selection = fileRevision = projectOwner = record = null; directory = {accounts:[],contacts:[]}; roleSelection = {};
    loading = saving = retriedScan = false;
    sites.hidden = true;
    for (const host of Object.values(hosts)) { host.hidden = true; host.closest("details").hidden = true; host.replaceChildren(); }
    projects.replaceChildren();
    text(siteStatus, "");
  }
  sites.addEventListener("toggle", () => {
    if (sites.open && (!record || record.scan_pending)) void load();
  });
  window.ClassifireProjectParticipants = {
    close, pending: () => saving || Boolean(history?.pending()), dirty: () => Boolean(history?.dirty()), fingerprint: () => history?.dirty() ? history.fingerprint() : null,
    async refresh(latest) {
      if (!selection || saving) return;
      const ticket = generation, previous = record;
      const data = await readRecord(false);
      if (ticket !== generation || saving || (previous && record !== previous)) return;
      if (latest) directory = latest;
      record = data; renderParticipants(); showProjects(data);
      await history?.refresh();
    },
    primaryChanged() {
      if (!record || saving) return;
      renderParticipants();
      const primary = window.CeasefireProjectPane?.primaryParties();
      if (primary && Object.entries(primary).some(([kind,id])=>id && !partyItem(kind,id))) void refreshDirectory();
    },
    scanComplete() { if (record?.scan_pending && sites.getClientRects().length) void load(); },
    show(file) {
      const selector = file?.id || (file?.save_token ? "native:" + file.save_token : null);
      if (selector && selector === selection && file.revision === fileRevision) return;
      close();
      const ticket = generation;
      history = window.ClassifireCrmActivity.historyPanel(() => {
        if (!selector) return {events:[]};
        const revision = projectOwner && record?.project_owner === projectOwner ? record.project_revision : file.revision;
        return api("crm/project-activity?" + new URLSearchParams({project:selector, revision}));
      }, () => ticket === generation, 'project-activity-heading', {
        canWrite:()=>Boolean(selector) && ticket === generation && canEdit() && !saving,
        write:activity=>api('crm/project-activity',{project:selector, revision:file.revision, activity})
      });
      hosts.contacts.closest("details").after(history.element);
      if (!selector) return;
      selection = selector; fileRevision = file.revision; projectOwner = file.source_project_id;
      sites.hidden = false;
      for (const host of Object.values(hosts)) host.hidden = false;
      text(siteStatus, "Loading…");
      void load();
    }
  };
})();
