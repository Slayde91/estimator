(() => {
  "use strict";
  const titles = {leads: "Leads", contacts: "Contacts", accounts: "Accounts"};
  const singular = {leads: "Lead", contacts: "Contact", accounts: "Account"};
  const labels = {name: "Name", phone: "Phone", company: "Company", title: "Title", email: "Email",
    site_address: "Site address", billing_address: "Billing address", description: "Description", status: "Status"};
  const personFields = ["name", "phone", "company", "title", "email"];
  let page = "leads", data, search = "", generation = 0, saving = false;
  const root = () => document.getElementById("contacts-root");
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
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
  function dialogEditor(kind, record = {}, readOnly = false) {
    const dialog = el("dialog", "contacts-dialog");
    const form = el("form", "contacts-form");
    const version = data.version;
    const heading = el("h2", "", readOnly ? record.name : (record.id ? "Edit " : "New ") + singular[kind]);
    heading.id = "contacts-editor-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    form.append(heading, notice());
    const fields = {};
    function group(headingText, keys) {
      const section = el("fieldset", "contacts-group");
      section.append(el("legend", "", headingText));
      for (const key of keys) {
        const label = el("label", "field", labels[key]);
        let input;
        if (key === "status") {
          input = el("select");
          data.statuses.forEach(value => input.add(new Option(value, value)));
        } else if (["description", "billing_address", "site_address"].includes(key)) {
          input = el("textarea");
          input.rows = key === "description" ? 3 : 2;
        } else {
          input = el("input");
          input.type = key === "email" ? "email" : key === "phone" ? "tel" : "text";
        }
        input.value = record[key] || (key === "status" ? data.statuses[0] : "");
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
      group("Lead Information", [...personFields, "status"]);
      group("Address Information", ["site_address", "billing_address"]);
      group("Description", ["description"]);
    } else if (kind === "accounts") {
      group("Account Information", ["company", "billing_address"]);
      if (record.id) {
        const related = el("section", "contacts-related");
        related.append(el("h3", "", "Related contacts"));
        const people = data.contacts.filter(contact => contact.account_id === record.id);
        if (!people.length) related.append(el("p", "helper", "No related contacts."));
        for (const person of people) related.append(button(person.name, () => {
          if (!form.reportValidity()) return;
          if (Object.keys(fields).some(key => fields[key].value !== record[key]) &&
              !window.confirm("Discard changes to this account?")) return;
          dialog.close();
          switchPage("contacts");
          dialogEditor("contacts", person);
        }, "text-button"));
        form.append(related);
      }
    } else {
      group("Contact Information", personFields);
    }
    const actions = el("div", "actions contacts-dialog-actions");
    const save = el("button", "button primary", "Save");
    save.type = "submit";
    const cancel = button("Cancel", () => dialog.close());
    if (readOnly) actions.append(button("Close", () => dialog.close()), button("Edit", () => {dialog.close(); dialogEditor(kind, record);}, "button primary"));
    else actions.append(cancel, save);
    form.append(actions);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (readOnly) return;
      save.disabled = cancel.disabled = true;
      const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
      try { await update(kind, {id: record.id, fields: values, version}, () => dialog.close()); }
      catch (error) {
        feedback(form, error.message, true);
        if (error.status === 409) dialog.addEventListener("close", () => activate(page), {once: true});
      }
      finally { save.disabled = cancel.disabled = false; }
    });
    dialog.append(form);
    dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
    dialog.addEventListener("close", () => dialog.remove(), {once: true});
    root().append(dialog);
    dialog.showModal();
  }
  function matches(row) {
    const keys = page === "accounts" ? ["company", "billing_address"] :
      page === "leads" ? [...personFields, "status", "site_address", "billing_address", "description"] : personFields;
    return keys.some(key => (row[key] || "").toLowerCase().includes(search.trim().toLowerCase()));
  }
  async function moveLead(lead, status) {
    if (lead.status === status || saving) return;
    const fields = Object.fromEntries([...personFields, "site_address", "billing_address", "description"].map(key => [key, lead[key]]));
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
    const keys = page === "accounts" ? ["company", "billing_address"] : ["name", "company", "title", "phone", "email"];
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
  window.ClassifireContacts = {activate};
})();
