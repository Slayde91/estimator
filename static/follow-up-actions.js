(() => {
  "use strict";

  const legacyId = "00000000-0000-4000-8000-000000000001";

  function rows({actions, next_action = "", follow_up_date = ""} = {}) {
    if (Array.isArray(actions)) return actions.map(row => ({
      id: row.id, next_action: row.next_action || "", follow_up_date: row.follow_up_date || "", status: row.status || ""
    }));
    return next_action || follow_up_date ? [{id:legacyId, next_action, follow_up_date, status:""}] : [];
  }

  function field(label, control) {
    const wrapper = document.createElement("label"), title = document.createElement("span");
    wrapper.className = "field";
    window.CeasefireI18n.text(title, label);
    window.CeasefireI18n.attr(control, "aria-label", label);
    wrapper.append(title, control);
    return wrapper;
  }

  function mount(host, options = {}) {
    const items = rows(options);
    const savedCount = items.length;
    const list = document.createElement("div"), add = document.createElement("button");
    list.className = "follow-up-action-list";
    add.type = "button";
    add.className = "button primary icon-only add-icon-action follow-up-add";
    for (const attribute of ["title", "aria-label"]) window.CeasefireI18n.attr(add, attribute, "Add follow-up");
    const plus = document.createElement("span");
    plus.className = "button-symbol add-symbol"; plus.setAttribute("aria-hidden", "true"); plus.textContent = "+";
    add.append(plus);

    function appendRow(item, persisted) {
      const row = document.createElement("div"), note = document.createElement("textarea");
      const date = document.createElement("input"), status = document.createElement("select");
      row.className = "follow-up-action-row"; row.dataset.actionId = item.id;
      note.rows = 1; note.maxLength = 500; note.value = item.next_action;
      date.type = "date"; date.max = "9999-12-31"; date.value = item.follow_up_date;
      if (options.idPrefix && !list.firstElementChild) {
        note.id = options.idPrefix + "-next-action";
        date.id = options.idPrefix + "-follow-up-date";
      }
      for (const [value, label] of [["","Pending"],["Completed","Completed"],["Canceled","Canceled"]]) {
        const option = document.createElement("option");
        option.value = value; window.CeasefireI18n.text(option, label); status.append(option);
      }
      status.value = item.status;
      function update() {
        const blank = !note.value.trim() && !date.value;
        const locked = Boolean(options.readOnly || status.value);
        note.readOnly = date.readOnly = locked;
        status.disabled = locked || blank;
        note.required = (persisted || Boolean(status.value)) && blank && !locked;
        note.setCustomValidity(note.required && note.value ? window.CeasefireI18n.translate("This field is required.") : "");
        row.dataset.status = status.value;
        Object.assign(item, {next_action:note.value, follow_up_date:date.value, status:status.value});
      }
      update();
      for (const input of [note, date]) input.addEventListener("input", () => {update(); options.onChange?.();});
      status.addEventListener("change", () => {
        if (!note.reportValidity() || !date.reportValidity()) { status.value = ""; return; }
        update();
        if (options.pendingOnly && status.value) {
          const next = row.nextElementSibling || row.previousElementSibling;
          row.remove();
          (next?.querySelector("textarea") || add).focus();
        }
        options.onChange?.();
      });
      row.append(field("Next action", note), field(options.dateLabel || "Follow-up date", date), field("Follow-up status", status));
      list.append(row);
      return note;
    }

    function blankRow() {
      const item = {id:crypto.randomUUID(), next_action:"", follow_up_date:"", status:""};
      items.push(item);
      return appendRow(item, false);
    }

    host.replaceChildren(list);
    // Saves include closed actions in their original order even when the editor only shows pending work.
    for (const item of items) if (!options.pendingOnly || !item.status) appendRow(item, true);
    if (!items.length && !options.readOnly) blankRow();
    if (!options.readOnly) {
      host.append(add);
      add.addEventListener("click", () => blankRow().focus());
    }
    return {
      value() {
        return items.filter((item, index) => index < savedCount || item.next_action.trim() || item.follow_up_date)
          .map(item => ({...item}));
      }
    };
  }

  let open;
  async function openDialog({trigger, recordName, load, save, onSaved, readOnly = false, restoreFocus}) {
    if (open?.open) return;
    const dialog = document.createElement("dialog"), form = document.createElement("form");
    open = dialog;
    dialog.className = "contacts-dialog follow-up-dialog";
    const title = document.createElement("h2"), name = document.createElement("p");
    title.id = "follow-up-dialog-title"; window.CeasefireI18n.text(title, "Follow-up actions");
    name.id = "follow-up-dialog-owner"; name.textContent = recordName;
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.setAttribute("aria-describedby", name.id);
    const fields = document.createElement("fieldset"), actions = document.createElement("div");
    const notice = document.createElement("p"), cancel = document.createElement("button"), submit = document.createElement("button");
    actions.className = "actions contacts-dialog-actions";
    notice.className = "notice error"; notice.setAttribute("role", "alert"); notice.hidden = true;
    cancel.className = "button secondary"; cancel.type = "button";
    window.CeasefireI18n.text(cancel, readOnly ? "Close" : "Cancel");
    submit.className = "button primary"; submit.type = "submit"; submit.disabled = true;
    window.CeasefireI18n.text(submit, "Save");
    actions.append(cancel); if (!readOnly) actions.append(submit);
    form.append(title, name, fields, notice, actions); dialog.append(form); document.body.append(dialog);
    let busy = false, loaded, editor, lastPayload, requestId, committed = false;
    const member = window.ClassifireAccess?.user?.id;
    function problem(error) {
      window.CeasefireI18n.text(notice, error.message); notice.hidden = false;
    }
    cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (open === dialog) open = null;
      (restoreFocus?.() || trigger)?.focus();
    }, {once:true});
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!editor || readOnly || busy || committed || !form.reportValidity()) return;
      if (member !== window.ClassifireAccess?.user?.id) {
        problem(new Error("Staff sign-in is required.")); return;
      }
      const values = editor.value(), payload = JSON.stringify(values);
      if (payload !== lastPayload) { requestId = crypto.randomUUID(); lastPayload = payload; }
      busy = true; fields.disabled = cancel.disabled = submit.disabled = true; notice.hidden = true;
      try {
        const result = await save(values, loaded, requestId);
        committed = true;
        await onSaved?.(result, loaded);
        dialog.close();
      } catch (error) { problem(error); }
      finally { busy = false; cancel.disabled = false; fields.disabled = submit.disabled = committed; }
    });
    dialog.showModal(); cancel.focus();
    fields.setAttribute("aria-busy", "true");
    try {
      loaded = await load();
      if (!dialog.open) return;
      editor = mount(fields, {actions:loaded.actions, pendingOnly:true, readOnly});
      submit.disabled = readOnly;
      if (!readOnly && document.activeElement === cancel) fields.querySelector("textarea")?.focus();
    } catch (error) { if (dialog.open) problem(error); }
    finally { fields.removeAttribute("aria-busy"); }
  }

  window.ClassifireFollowUpActions = {rows, mount, openDialog};
})();
