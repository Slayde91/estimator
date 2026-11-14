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
    wrapper.append(title, control);
    return wrapper;
  }

  function mount(host, options = {}) {
    const initial = rows(options);
    const controls = [];
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
      if (options.idPrefix && !controls.length) {
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
        note.required = persisted && blank && !locked;
        note.setCustomValidity(note.required && note.value ? window.CeasefireI18n.translate("This field is required.") : "");
        row.dataset.status = status.value;
      }
      update();
      for (const input of [note, date]) input.addEventListener("input", () => {update(); options.onChange?.();});
      status.addEventListener("change", () => {
        if (!note.reportValidity() || !date.reportValidity()) { status.value = ""; return; }
        update(); options.onChange?.();
      });
      row.append(field("Next action", note), field(options.dateLabel || "Follow-up date", date), field("Follow-up status", status));
      list.append(row);
      controls.push({id:item.id, persisted, note, date, status});
      return note;
    }

    function blankRow() {
      return appendRow({id:crypto.randomUUID(), next_action:"", follow_up_date:"", status:""}, false);
    }

    host.replaceChildren(list);
    for (const item of initial) appendRow(item, true);
    if (!initial.length) blankRow();
    if (!options.readOnly) {
      host.append(add);
      add.addEventListener("click", () => blankRow().focus());
    }
    return {
      value() {
        return controls.filter(({persisted, note, date}) => persisted || note.value.trim() || date.value)
          .map(({id, note, date, status}) => ({id, next_action:note.value, follow_up_date:date.value, status:status.value}));
      }
    };
  }

  window.ClassifireFollowUpActions = {rows, mount};
})();
