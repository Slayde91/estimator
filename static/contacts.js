(() => {
  "use strict";
  const titles = {leads: "Leads", contacts: "Contacts", accounts: "Accounts"};
  const singular = {leads: "Lead", contacts: "Contact", accounts: "Account"};
  const labels = {name: "Name", phone: "Phone", company: "Company", title: "Title", email: "Email", abn_acn: "ABN/ACN",
    site_address: "Site address", billing_address: "Billing address", description: "Description", status: "Status"};
  const personFields = ["name", "phone", "company", "title", "email"];
  let page = "leads", data, search = "", generation = 0, saving = false, editorSequence = 0;
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
  function button(text, action, cls = "button secondary") {
    const node = el("button", cls, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function feedback(container, message, error = false) {
    const msg = container.querySelector("[data-contacts-notice]");
    msg.textContent = message;
    msg.hidden = !message;
    msg.classList.toggle("error", error);
  }
  function notice() {
    const node = el("p", "notice");
    node.dataset.contactsNotice = "";
    node.setAttribute("role", "status");
    node.hidden = true;
    return node;
  }
  async function request(path, body) {
    const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)};
    const response = await fetch("/api/contacts/" + path, options);
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || "The directory could not be updated.");
      error.status = response.status;
      throw error;
    }
    return value;
  }
  async function activate(kind) {
    const ticket = ++generation;
    if (Object.hasOwn(titles, kind)) page = kind;
    search = "";
    root().setAttribute("aria-busy", "true");
    try {
      const directory = await request("directory");
      if (ticket !== generation) return;
      data = directory;
      render();
    } catch (error) {
      if (ticket !== generation) return;
      root().replaceChildren(el("p", "notice error", error.message), button("Retry", () => activate(page)));
    } finally {
      if (ticket === generation) root().removeAttribute("aria-busy");
    }
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
    } finally { saving = false; }
  }
  function dialogEditor(kind, record = {}, readOnly = false, options = {}) {
    const dialog = el("dialog", "contacts-dialog");
    const form = el("form", "contacts-form");
    const directory = options.directory || data;
    const version = directory.version;
    let resolveClosed, savedRecord = null, submitting = false, loadingLinks = false, linksReady = kind !== "accounts";
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const heading = el("h2", "", readOnly ? record.name : (record.id ? "Edit " : "New ") + singular[kind]);
    if (!readOnly) copy(heading, (record.id ? "Edit " : "New ") + singular[kind]);
    heading.id = "contacts-editor-title-" + ++editorSequence;
    dialog.setAttribute("aria-labelledby", heading.id);
    form.append(heading, notice());
    const fields = {};
    function group(headingText, keys) {
      const section = el("fieldset", "contacts-group");
      section.append(ui("legend", "", headingText));
      for (const key of keys) {
        const label = el("label", "field");
        if (window.CeasefireI18n) window.CeasefireI18n.nodeText(label, labels[key]);
        else label.textContent = labels[key];
        let input;
        if (key === "status") {
          input = el("select");
          directory.statuses.forEach(value => input.add(new Option(value, value)));
        } else if (["description", "billing_address", "site_address"].includes(key)) {
          input = el("textarea");
          input.rows = key === "description" ? 3 : 2;
        } else {
          input = el("input");
          input.type = key === "email" ? "email" : key === "phone" ? "tel" : "text";
        }
        input.value = record[key] || (key === "status" ? directory.statuses[0] : "");
        input.required = key === "name" || (key === "company" && kind !== "contacts");
        input.name = key;
        if (readOnly) { if (input.tagName === "SELECT") input.disabled = true; else input.readOnly = true; }
        fields[key] = input;
        label.append(input);
        section.append(label);
      }
      form.append(section);
    }
    if (kind === "leads") {
      group("Lead Information", [...personFields, "abn_acn", "status"]);
      group("Address Information", ["site_address", "billing_address"]);
      group("Description", ["description"]);
    } else if (kind === "accounts") {
      group("Account Information", ["company", "abn_acn", "billing_address"]);
    } else {
      group("Contact Information", personFields);
    }
    const actions = el("div", "actions contacts-dialog-actions");
    const save = ui("button", "button primary", "Save");
    save.type = "submit";
    save.disabled = !linksReady;
    const cancel = button("Cancel", () => dialog.close());
    copy(cancel, "Cancel");
    if (readOnly) actions.append(button("Close", () => dialog.close()), button("Edit", () => {dialog.close(); dialogEditor(kind, record);}, "button primary"));
    else actions.append(cancel, save);
    const linkSelections = {};
    if (kind === "accounts") {
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
      const findControls = el("div", "contacts-link-controls");
      const refresh = button("Refresh linked records", () => loadLinks(true));
      copy(refresh, "Refresh linked records");
      const unavailable = el("details", "contacts-link-errors");
      unavailable.hidden = true;
      const unavailableSummary = el("summary"), unavailableList = el("ul");
      unavailable.append(unavailableSummary, unavailableList);
      findControls.append(findLabel, refresh);
      related.append(ui("h3", "", "Linked records"), findControls, linkStatus, unavailable, groups);
      form.append(related);
      const knownEntries = {}, initialSelections = {};
      let linkTicket = 0, searchTimer;
      find.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadLinks(true), 250);
      });
      find.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        clearTimeout(searchTimer);
        loadLinks(true);
      });
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
          if (!dialog.open || ticket !== linkTicket) return;
          const openGroups = new Set([...groups.querySelectorAll("details[open]")].map(group => group.dataset.linkGroup));
          groups.replaceChildren();
          for (const [key, title] of Object.entries(linkTitles)) {
            const linked = catalog.linked[key] || [], choices = catalog.choices[key] || [];
            const selected = preserveSelection && linkSelections[key] ? linkSelections[key] : new Set(linked.map(item => item.id));
            for (const item of linked) if (item.automatic) selected.add(item.id);
            if (!initialSelections[key]) initialSelections[key] = new Set(linked.map(item => item.id));
            linkSelections[key] = selected;
            if (!knownEntries[key]) knownEntries[key] = new Map();
            for (const item of [...choices, ...linked]) knownEntries[key].set(item.id, item);
            const all = new Map([...choices, ...linked].map(item => [item.id, item]));
            for (const id of selected) if (!all.has(id) && knownEntries[key].has(id)) all.set(id, knownEntries[key].get(id));
            const group = el("details", "contacts-links-group");
            group.dataset.linkGroup = key;
            group.open = preserveSelection ? openGroups.has(key) || Boolean(find.value.trim() && choices.length) : key === "contacts" || linked.length > 0;
            const summary = el("summary");
            const summaryText = () => copy(summary, "{0} ({1})", [window.CeasefireI18n?.term(title) || title, selected.size]);
            summaryText();
            const body = el("div", "contacts-links-body");
            const list = el("ul", "contacts-links-list");
            function showChoices(focusId) {
              const term = find.value.trim().toLowerCase();
              const entries = [...all.values()].filter(item => (selected.has(item.id) || item.available) &&
                (!term || item.label.toLowerCase().includes(term)));
              entries.sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.label.localeCompare(b.label));
              list.replaceChildren();
              let focusTarget;
              for (const item of entries.slice(0, 100)) {
                const row = el("li", "contacts-link-row");
                const label = el("label", "contacts-link-option");
                const checkbox = el("input");
                checkbox.type = "checkbox";
                checkbox.checked = selected.has(item.id);
                checkbox.disabled = readOnly || Boolean(item.automatic);
                checkbox.setAttribute("aria-label", "Link " + item.label);
                window.CeasefireI18n?.attr(checkbox, "aria-label", "Link {0}", [item.label]);
                checkbox.addEventListener("change", () => {
                  if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
                  summaryText();
                  showChoices(item.id);
                });
                if (item.id === focusId) focusTarget = checkbox;
                label.append(checkbox);
                row.append(label);
                const person = key === "contacts" && directory.contacts.find(contact => contact.id === item.id);
                if (person && selected.has(item.id) && !options.standalone) {
                  const openContact = button(person.name, () => {
                    const changed = Object.keys(fields).some(field => fields[field].value !== (record[field] || "")) ||
                      Object.keys(linkTitles).some(linkKey => {
                        const initial = initialSelections[linkKey];
                        const current = linkSelections[linkKey];
                        return initial.size !== current.size || [...initial].some(id => !current.has(id));
                      });
                    if (changed && !window.confirm("Discard changes to this account?")) return;
                    dialog.close();
                    switchPage("contacts");
                    dialogEditor("contacts", person);
                  }, "text-button");
                  row.append(openContact);
                } else label.append(el("span", "", item.label));
                if (item.automatic) row.append(ui("p", "helper", "Linked through this account's saved project."));
                else if (!item.available) row.append(ui("p", "helper", "Unavailable saved record. Clear the selection to remove this link."));
                else if (key === "contacts" && item.account_id && item.account_id !== record.id)
                  row.append(ui("p", selected.has(item.id) ? "contacts-reassignment" : "helper", selected.has(item.id) ?
                    "Saving will move this contact from {0}." : "Currently linked to {0}.", [item.account_label]));
                list.append(row);
              }
              if (!entries.length) list.append(ui("li", "helper", find.value.trim() ? "No matching records." : "No records available to link."));
              if (entries.length > 100) list.append(ui("li", "helper", "Showing the first 100 records. Search to find another record."));
              focusTarget?.focus();
            }
            showChoices();
            body.append(list);
            group.append(summary, body);
            groups.append(group);
          }
          linksReady = true;
          save.disabled = false;
          unavailable.hidden = !catalog.error_count;
          copy(unavailableSummary, "Unavailable project records ({0})", [catalog.error_count || 0]);
          unavailableList.replaceChildren(...(catalog.errors || []).map(item => el("li", "", item.name)));
          copy(linkStatus, catalog.error_count ? "Some project records are unavailable. Current links are retained." :
            catalog.scan_pending ? "Project records are still loading. Refresh to list more records." :
            catalog.truncated ? "Search by name to find more records. Current links are retained." :
              "Select existing records to link to this account. Project links do not change the project details.");
        } catch (error) {
          if (!dialog.open || ticket !== linkTicket) return;
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
    form.append(actions);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (readOnly || submitting || saving || loadingLinks || !linksReady) return;
      submitting = saving = true;
      save.disabled = cancel.disabled = true;
      form.setAttribute("aria-busy", "true");
      const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
      const links = kind === "accounts" ? Object.fromEntries(Object.entries(linkSelections).map(([key, selected]) => [key, [...selected]])) : undefined;
      const editable = [...form.querySelectorAll("input,textarea,select,button")].filter(input => !input.disabled);
      editable.forEach(input => { input.disabled = true; });
      try {
        const result = await request(kind, {id: record.id, fields: values, version, ...(links ? {links} : {})});
        savedRecord = kind === "accounts" ? result.account : null;
        dialog.close();
        if (!options.standalone) await activate(page);
      }
      catch (error) {
        feedback(form, error.message, true);
        if (error.status === 409 && !options.standalone) dialog.addEventListener("close", () => activate(page), {once: true});
      }
      finally {
        submitting = saving = false;
        editable.forEach(input => { input.disabled = false; });
        save.disabled = cancel.disabled = false;
        form.removeAttribute("aria-busy");
      }
    });
    dialog.append(form);
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
    dialog.addEventListener("close", () => { dialog.remove(); resolveClosed(savedRecord); }, {once: true});
    (options.standalone ? document.body : root()).append(dialog);
    dialog.showModal();
    return closed;
  }
  async function createAccount(options = {}) {
    const directory = await request("directory");
    return dialogEditor("accounts", {company: typeof options.company === "string" ? options.company : ""}, false, {directory, standalone: true});
  }
  function matches(row) {
    const keys = page === "accounts" ? ["company", "abn_acn", "billing_address"] :
      page === "leads" ? [...personFields, "abn_acn", "status", "site_address", "billing_address", "description"] : personFields;
    return keys.some(key => (row[key] || "").toLowerCase().includes(search.trim().toLowerCase()));
  }
  async function moveLead(lead, status) {
    if (lead.status === status || saving) return;
    const fields = Object.fromEntries([...personFields, "abn_acn", "site_address", "billing_address", "description"].map(key => [key, lead[key]]));
    try { await update("leads", {id: lead.id, version: data.version, fields: {...fields, status}}); }
    catch (error) { feedback(root(), error.message, true); }
  }
  function leadBoard(rows) {
    const board = el("div", "project-kanban contacts-board");
    for (const status of data.statuses) {
      const column = el("section", "project-kanban-column");
      column.dataset.status = status;
      const group = rows.filter(lead => lead.status === status);
      const heading = el("div", "project-column-heading");
      heading.append(el("h2", "", status), el("span", "badge", group.length));
      column.append(heading);
      for (const lead of group) {
        const card = el("article", "project-kanban-card");
        card.draggable = true;
        card.addEventListener("dragstart", event => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-classifire-lead", lead.id);
        });
        const row = el("div", "project-card-heading"), menu = el("details", "commercial-card-menu contacts-lead-menu");
        const toggle = el("summary", "", "▾");
        toggle.setAttribute("aria-label", `Actions for ${lead.name}`);
        const options = el("div", "commercial-menu-options");
        for (const [name, open] of [["Open", true], ["Edit", false]]) {
          options.append(button(name, () => {menu.open = false; dialogEditor("leads", lead, open);}, "text-button"));
        }
        options.append(button("Convert", async () => {
          menu.open = false;
          try {
            const saved = await update("leads/convert", {id:lead.id, version:data.version});
            if (saved) await window.CeasefireProject?.openConvertedLead(saved);
          }
          catch (error) {feedback(root(), error.message, true);}
        }, "text-button"));
        menu.append(toggle, options);
        menu.addEventListener("toggle", () => {
          if (!menu.open) return;
          const rect = toggle.getBoundingClientRect();
          options.style.left = `${Math.max(8, Math.min(innerWidth - options.offsetWidth - 8, rect.right - options.offsetWidth))}px`;
          options.style.top = `${rect.bottom + options.offsetHeight + 12 <= innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - options.offsetHeight - 6)}px`;
        });
        row.append(button(lead.name, () => dialogEditor("leads", lead, true), "text-button project-title-button"), menu);
        card.append(row);
        const details = el("dl", "kanban-card-details");
        for (const key of ["company", "title", "phone", "email"]) {
          if (!lead[key] && key !== "company") continue;
          details.append(el("dt", "", labels[key]), el("dd", "", lead[key] || "—"));
        }
        card.append(details);
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
    if (!rows.length) wrapper.append(el("p", "helper", "No matching " + page + "."));
    return wrapper;
  }
  function displayRows() {
    const host = root().querySelector(".contacts-results");
    const rows = data[page].filter(matches);
    host.replaceChildren(page === "leads" ? leadBoard(rows) : directoryTable(rows));
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
  function switchPage(kind) {
    page = kind;
    search = "";
    render();
  }
  function render() {
    const container = root();
    container.replaceChildren();
    const heading = el("div", "page-heading");
    const title = el("div");
    title.append(el("p", "eyebrow", "CONTACTS"), el("h1", "", titles[page]));
    heading.append(title);
    const tabs = el("nav", "calculator-pages contacts-tabs");
    tabs.setAttribute("aria-label", "Contacts pages");
    for (const [key, label] of Object.entries(titles)) {
      const tab = button(label, () => switchPage(key), "calculator-page");
      tab.setAttribute("aria-pressed", String(key === page));
      if (key === page) tab.setAttribute("aria-current", "page");
      tabs.append(tab);
    }
    for (const choice of document.querySelectorAll("#contacts-navigation-menu [data-contacts-section]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.contactsSection === page));
    }
    const section = el("section", "card contacts-workspace");
    const controls = el("div", "contacts-controls");
    const searchLabel = el("label", "field", "Search " + page);
    const input = el("input");
    input.type = "search"; input.value = search;
    input.addEventListener("input", () => { search = input.value; displayRows(); });
    searchLabel.append(input);
    controls.append(searchLabel);
    if (page !== "leads") controls.append(documentMenu(page));
    controls.append(button("New " + singular[page], () => dialogEditor(page), "button primary"));
    section.append(controls, el("div", "contacts-results"));
    container.append(heading, tabs, notice(), section);
    displayRows();
  }
  document.addEventListener("click", event => {
    root()?.querySelectorAll("details[open]").forEach(menu => {if (!menu.contains(event.target)) menu.open = false;});
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menu = event.target.closest?.("#contacts-root details[open]");
    if (menu) {menu.open = false; menu.querySelector("summary").focus();}
  });
  window.ClassifireContacts = {activate, createAccount};
})();
