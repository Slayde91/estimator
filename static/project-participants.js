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
  sites.append(ui("summary", "Linked Sites"), ui("h4", "Linked Projects"), projects, siteStatus);
  document.getElementById("project-pricing-notice").before(sites);

  let selection = null, fileRevision = null, record = null, generation = 0;
  let saving = false, loading = false, scanTimer, retriedScan = false;
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

  async function readRecord() {
    const data = await api("crm/project-participants?project=" + encodeURIComponent(selection));
    if (fileRevision && data.project_revision !== fileRevision) throw Error("The project changed. Reopen its details before changing participants.");
    return data;
  }

  async function save(rows, host) {
    if (saving || !record || !canEdit()) return;
    const ticket = generation;
    clearTimeout(scanTimer);
    saving = true;
    lockParticipants(true);
    try {
      const data = await api("crm/project-participants", {
        project: selection, project_revision: record.project_revision, version: record.version,
        participants: rows.map(({role, kind, id}) => ({role, kind, id})), site_id: record.site_id
      });
      if (ticket !== generation) return;
      record = data;
      renderParticipants();
      showProjects(data);
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
      host.replaceChildren();
      const entries = record.participants.filter(item => item.kind === kind);
      const group = el("fieldset"), note = status();
      const primaryId = window.CeasefireProjectPane?.primaryParties()[kind];
      const recorded = new Set(entries.map(item => item.id));
      const linked = new Map();
      for (const item of record.linked_parties || []) {
        if (item.kind !== kind || item.id === primaryId || recorded.has(item.id)) continue;
        const previous = linked.get(item.id);
        if (previous) { previous.roles.add(item.role); previous.label ||= item.label; }
        else linked.set(item.id, {label: item.label, roles: new Set([item.role])});
      }
      if (entries.length || linked.size) {
        const list = el("ul");
        for (const item of entries) {
          const row = el("li");
          row.append(el("strong", item.label), " · ", ui("span", record.roles[item.role] || item.role));
          if (canEdit()) {
            const remove = ui("button", "Remove");
            remove.type = "button"; remove.className = "text-button";
            remove.onclick = () => void save(record.participants.filter(entry =>
              entry.kind !== kind || entry.id !== item.id || entry.role !== item.role), host);
            row.append(" ", remove);
          }
          list.append(row);
        }
        for (const {label, roles} of linked.values()) {
          const row = el("li");
          if (label) row.append(el("strong", label), " · ");
          [...roles].forEach((role, index) => { if (index) row.append(" · "); row.append(ui("span", role)); });
          list.append(row);
        }
        group.append(list);
      }
      if (canEdit()) {
        const add = el("details"), role = el("select"), label = ui("label", "Role");
        const labelId = kind === "accounts" ? "Company" : "Contact";
        role.id = "project-participant-role-" + kind;
        label.htmlFor = role.id;
        for (const [key, name] of Object.entries(record.roles)) {
          const option = ui("option", name); option.value = key; role.append(option);
        }
        if (kind === "contacts") role.value = "site_contact";
        const field = el("div"); field.className = "field"; field.append(label, role);
        const search = window.ClassifireCommercialDirectory.field(labelId, {
          kind, isCurrent: () => !!selection && !saving && canEdit() && !host.inert && !pane.inert,
          account: () => ({id: window.CeasefireProjectPane.primaryParties().accounts}),
          read: () => "", onInput() {}, message: value => text(note, value),
          filter: (item, directory) => (kind !== "contacts" || contactCompanyIsLinked(item, directory, companyIds)) &&
            !entries.some(entry => entry.id === item.id && entry.role === role.value),
          onSelect: item => void save([...record.participants, {role: role.value, kind, id: item.id}], host)
        });
        add.append(ui("summary", "Add"), field, search.element);
        group.append(add);
      }
      if (group.childElementCount) host.append(group, note);
    }
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
      const data = await readRecord();
      if (ticket !== generation || saving || record !== previous) return;
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
    clearTimeout(scanTimer);
    selection = fileRevision = record = null;
    loading = saving = retriedScan = false;
    sites.hidden = true;
    for (const host of Object.values(hosts)) { host.hidden = true; host.replaceChildren(); }
    projects.replaceChildren();
    text(siteStatus, "");
  }
  sites.addEventListener("toggle", () => {
    if (sites.open && (!record || record.scan_pending)) void load();
  });
  window.ClassifireProjectParticipants = {
    close, pending: () => saving,
    scanComplete() { if (record?.scan_pending && sites.getClientRects().length) void load(); },
    show(file) {
      const selector = file?.id || (file?.save_token ? "native:" + file.save_token : null);
      if (selector && selector === selection && file.revision === fileRevision) return;
      close();
      if (!selector) return;
      selection = selector; fileRevision = file.revision;
      sites.hidden = false;
      for (const host of Object.values(hosts)) host.hidden = false;
      text(siteStatus, "Loading…");
      void load();
    }
  };
})();
