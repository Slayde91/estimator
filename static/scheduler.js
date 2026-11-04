(() => {
  "use strict";
  const ZONE = "Australia/Sydney";
  const state = {root:null, data:null, page:"schedule", week:weekStart(today()), member:"", mine:false,
    loading:0, busy:false, dialog:null, watch:null, lastLocation:0, locationEnabled:false, timer:null, projects:[]};
  const colours = [["#2196f3","Blue"],["#b12030","Red"],["#177349","Green"],["#7544a8","Purple"],["#505966","Grey"]];
  const dayFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:ZONE, weekday:"short", day:"numeric", month:"short"});
  const dateFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:ZONE, day:"numeric", month:"short", hour:"numeric", minute:"2-digit"});
  const timeFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:ZONE, hour:"numeric", minute:"2-digit"});
  function el(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }
  function button(text, action, className = "button secondary") {
    const result = el("button", className, text); result.type = "button";
    result.addEventListener("click", action); return result;
  }
  function input(type, value = "", attributes = {}) {
    const result = el("input"); result.type = type; result.value = value;
    if (type === "datetime-local") result.step = "1";
    Object.entries(attributes).forEach(([key, val]) => result.setAttribute(key, String(val))); return result;
  }
  function field(label, control, hint) {
    const result = el("label", "field"); result.append(el("span", "", label), control);
    if (hint) result.append(el("small", "helper", hint)); return result;
  }
  function select(options, value) {
    const result = el("select");
    options.forEach(([id,label]) => { const option = el("option", "", label); option.value = id; result.append(option); });
    result.value = value; return result;
  }
  function check(text, checked = false) {
    const control = input("checkbox"); control.checked = checked;
    const label = el("label", "scheduler-check"); label.append(control, el("span", "", text));
    return {control,label};
  }
  function today() { return localParts(new Date()).slice(0,10); }
  function addDays(date, amount) {
    const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0,10);
  }
  function weekStart(date) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -(day + 6) % 7); }
  function localParts(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));
    const values = Object.fromEntries(parts.map(part => [part.type,part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
  }
  function duration(start,end) { return Math.max(0, (new Date(end || Date.now()) - new Date(start)) / 60000); }
  function hours(minutes) { const rounded = Math.round(minutes); return `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2,"0") }m`; }
  function memberName(id) { return state.data.members.find(member => member.id === id)?.name || "Unassigned"; }
  function admin() { return state.data?.user?.role === "admin"; }
  function projectSelect(record = {}) {
    const options = [["","No project assigned"],...state.projects.map(project => [project.id,project.title || project.name])];
    if (record.project_id && !options.some(([id]) => id === record.project_id)) options.push([record.project_id,record.project_name || record.project_id]);
    return select(options,record.project_id || "");
  }
  function projectName(control) { return control.value ? control.selectedOptions[0]?.textContent || "" : ""; }
  async function loadProjects() {
    const records = new Map(); let offset = 0;
    for (let page = 0; page < 100; page++) {
      const response = await fetch(`/api/projects?offset=${offset}`,{credentials:"same-origin",cache:"no-store"});
      if (!response.ok) throw new Error("Saved projects could not be loaded. Existing project assignments are retained.");
      const data = await response.json();
      for (const project of data.files || []) records.set(project.id,project);
      if (data.scan_pending) continue;
      offset += (data.files || []).length;
      if (!data.files?.length || offset >= (data.matched ?? offset)) break;
    }
    state.projects = [...records.values()];
  }
  function notice(message, error = false) {
    const host = state.root?.querySelector(".scheduler-notice"); if (!host) return;
    host.textContent = message; host.classList.toggle("error",error); host.hidden = !message;
  }
  async function request(path, payload) {
    const response = await fetch(`/api/scheduler${path}`, {credentials:"same-origin", cache:"no-store",
      ...(payload === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})});
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) stopLocation();
      const error = new Error(data.error || "The Scheduler request could not be completed."); error.status = response.status; throw error;
    }
    return data;
  }
  async function refresh() {
    const revision = ++state.loading;
    try {
      const data = await request(`/state?start=${state.week}&end=${addDays(state.week,7)}`);
      if (revision !== state.loading) return;
      state.data = data;
      if (!data.active_entry?.location_consent) stopLocation();
      else if (!state.locationEnabled) {
        try { if (sessionStorage.getItem("classifire-scheduler-location-entry") === data.active_entry.id) startLocation(); } catch (_) { /* Storage may be unavailable. */ }
      }
      render();
    } catch (error) {
      if (error.status === 401) {state.data = null; auth(false);}
      notice(error.message, true);
    }
  }
  async function mutate(path,payload) {
    if (state.busy) return;
    state.busy = true;
    try { await request(path,payload); await refresh(); }
    catch (error) { notice(error.message,true); }
    finally { state.busy = false; }
  }
  function shell() {
    state.root.replaceChildren();
    const status = el("p", "scheduler-notice message"); status.setAttribute("role","status"); status.hidden = true;
    state.root.append(status);
  }
  function closeDialog() { state.dialog?.close(); state.dialog?.remove(); state.dialog = null; }
  function dialog(title, build, saveLabel, save) {
    closeDialog();
    const modal = el("dialog", "scheduler-dialog"), form = el("form", "scheduler-form");
    const heading = el("div", "section-heading");
    const titleNode = el("h2", "", title); titleNode.id = "scheduler-dialog-title";
    modal.setAttribute("aria-labelledby",titleNode.id);
    heading.append(titleNode,button("Close",closeDialog));
    const content = el("div", "scheduler-form-fields"), error = el("p", "message error"); error.hidden = true; error.setAttribute("role","alert");
    const controls = build(content), actions = el("div", "actions scheduler-dialog-actions");
    const submit = el("button", "button", saveLabel); submit.type = "submit";
    actions.append(button("Cancel",closeDialog),submit); form.append(heading,content,error,actions); modal.append(form);
    modal.addEventListener("close", () => { modal.remove(); if (state.dialog === modal) state.dialog = null; });
    form.addEventListener("submit",async event => {
      event.preventDefault(); if (submit.disabled) return; submit.disabled = true; error.hidden = true;
      try { await save(controls); closeDialog(); await refresh(); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { submit.disabled = false; }
    });
    state.root.append(modal); state.dialog = modal; modal.showModal();
    return modal;
  }
  function auth(setup) {
    shell();
    const card = el("section", "card scheduler-auth"), form = el("form", "scheduler-form");
    form.append(el("h2", "", setup ? "Set up your Scheduler" : "Sign in to Scheduler"),el("p", "helper",setup ? "Create the first administrator account to manage your team and schedules." : "Use your CLASSIFIRE Scheduler account to see your schedule and record time."));
    const name = input("text","",{required:true,maxlength:120,autocomplete:"name"});
    const email = input("email","",{required:true,maxlength:254,autocomplete:"username"});
    const password = input("password","",{required:true,minlength:12,maxlength:128,autocomplete:setup ? "new-password" : "current-password"});
    if (setup) form.append(field("Your name",name));
    form.append(field("Email",email),field("Password",password,setup ? "Use at least 12 characters." : ""));
    const submit = el("button", "button",setup ? "Create administrator account" : "Sign in"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit",async event => {
      event.preventDefault(); if (submit.disabled) return; submit.disabled = true;
      try { await request(setup ? "/setup" : "/login",{...(setup ? {name:name.value} : {}),email:email.value,password:password.value}); password.value = ""; state.page = "schedule"; state.member = ""; state.mine = false; await refresh(); }
      catch (error) { notice(error.message,true); } finally { submit.disabled = false; }
    });
    card.append(form); state.root.append(card);
  }
  function render() {
    if (!state.data?.user) return auth(false);
    shell();
    const top = el("div", "scheduler-top"), tabs = el("nav", "scheduler-tabs"); tabs.setAttribute("aria-label","Scheduler pages");
    const pages = [["schedule","Schedule"],["entries","Time entries"],...(admin() ? [["team","Team members"],["settings","Settings"]] : [])];
    pages.forEach(([id,label]) => {
      const tab = button(label,() => { state.page = id; render(); }); tab.setAttribute("aria-current",state.page === id ? "page" : "false"); tabs.append(tab);
    });
    const account = el("div", "scheduler-account"); account.append(el("span","",state.data.user.name),button("Sign out",async () => {
      try { await request("/logout",{}); stopLocation(); state.data = null; auth(false); }
      catch (error) { notice(error.message,true); }
    })); top.append(tabs,account); state.root.append(top);
    renderClock();
    if (state.page === "schedule") renderSchedule();
    if (state.page === "entries") renderEntries();
    if (state.page === "team" && admin()) renderTeam();
    if (state.page === "settings" && admin()) renderSettings();
  }
  function renderClock() {
    const active = state.data.active_entry, bar = el("section", "scheduler-clock card"); bar.setAttribute("aria-label","Your time clock");
    const summary = el("div"); summary.append(el("strong","",active ? "You are clocked in" : "Your time clock"));
    if (active) summary.append(el("p","helper",`Started ${dateFormatter.format(new Date(active.start))} · ${hours(duration(active.start))}`));
    else summary.append(el("p","helper","Record your working time in Australia/Sydney."));
    bar.append(summary);
    if (active) {
      const openBreak = active.breaks?.find(item => !item.end);
      bar.append(button(openBreak ? "End break" : "Start break",() => {
        if (openBreak) return mutate("/clock/break",{entry_id:active.id,version:active.version,action:"end",paid:openBreak.paid});
        dialog("Start a break",host => {
          const choices = (state.data.settings.breaks || []).map((item,index) => [String(index),`${item.name} · ${item.minutes} min · ${item.paid ? "paid" : "unpaid"}`]);
          const kind = select(choices,"0"); host.append(field("Break",kind),el("p","helper","The break ends when you select End break. Time is recorded for the actual break duration.")); return {kind};
        },"Start break",async ({kind}) => request("/clock/break",{entry_id:active.id,version:active.version,action:"start",paid:!!state.data.settings.breaks[Number(kind.value)]?.paid}));
      }));
      if (active.location_consent) {
        bar.append(button(state.locationEnabled ? "Stop location recording" : "Record my locations",() => {
          if (state.locationEnabled) stopLocation(); else startLocation();
          render();
        }));
      }
      bar.append(button("Clock out",async () => { await mutate("/clock/out",{entry_id:active.id,version:active.version}); if (!state.data?.active_entry) stopLocation(); },"button"));
      bar.append(el("p","helper scheduler-clock-note",openBreak ? "You are on a break." : state.locationEnabled ? "Location recording is on while this browser can access your location." : "Location recording is off."));
    } else bar.append(button("Clock in",() => dialog("Clock in",host => {
      const project = projectSelect(), notes = el("textarea"), location = check("Record my location while clocked in"); notes.maxLength = 2000;
      host.append(field("Job / project reference",project),field("Notes",notes),location.label,el("p","helper","Locations are recorded only with your permission while you are clocked in. Keep this browser open. A closed or suspended browser cannot record your location.")); return {project,notes,location};
    },"Clock in",async ({project,notes,location}) => {
      const entry = await request("/clock/in",{project_id:project.value,project_name:projectName(project),notes:notes.value,location_consent:location.control.checked});
      state.data.active_entry = entry;
      if (location.control.checked) startLocation();
    }),"button"));
    state.root.append(bar);
  }
  function weekControls() {
    const controls = el("div", "scheduler-toolbar");
    const date = input("date",state.week,{"aria-label":"Week containing date"});
    date.addEventListener("change",() => { if (date.value) { state.week = weekStart(date.value); refresh(); } });
    controls.append(button("Today",() => {state.week = weekStart(today()); refresh();}),button("←",() => {state.week = addDays(state.week,-7); refresh();}),date,button("→",() => {state.week = addDays(state.week,7); refresh();}));
    controls.children[1].setAttribute("aria-label","Previous week"); controls.children[3].setAttribute("aria-label","Next week");
    controls.append(el("strong", "scheduler-week",`${dayFormatter.format(new Date(`${state.week}T12:00:00Z`))} – ${dayFormatter.format(new Date(`${addDays(state.week,6)}T12:00:00Z`))}`));
    return controls;
  }
  function renderSchedule() {
    const controls = weekControls();
    const filter = select([["","All team members"],...state.data.members.filter(item => item.active).map(item => [item.id,item.name])],state.member);
    filter.setAttribute("aria-label","Filter team members"); filter.addEventListener("change",() => {state.member = filter.value; render();}); controls.append(filter);
    const mine = check("My schedule",state.mine); mine.control.addEventListener("change",() => {state.mine = mine.control.checked; render();}); controls.append(mine.label);
    if (admin()) controls.append(button("Add shift",() => editShift(),"button"));
    state.root.append(controls,el("p","helper","Week view · Australia/Sydney · Select a shift for details."));
    const scroll = el("div", "scheduler-grid-scroll"), table = el("table", "scheduler-grid"); table.append(el("caption", "sr-only","Weekly schedule by team member"));
    const head = el("thead"), row = el("tr"); row.append(el("th","scheduler-person","Team member"));
    for(let day=0;day<7;day++) { const date = addDays(state.week,day), cell = el("th",date === today() ? "scheduler-today" : "",dayFormatter.format(new Date(`${date}T12:00:00Z`))); cell.scope = "col"; row.append(cell); }
    head.append(row); table.append(head); const body = el("tbody");
    let members = [{id:"",name:"Unassigned",active:true},...state.data.members.filter(item => item.active)];
    if (state.mine) members = members.filter(item => item.id === state.data.user.id);
    if (state.member) members = members.filter(item => item.id === state.member);
    members.forEach(member => {
      const tr = el("tr"), label = el("th", "scheduler-person"); label.scope = "row";
      const initials = member.name.split(/\s+/).slice(0,2).map(word => word[0]).join(""); label.append(el("span","scheduler-avatar",initials),el("span","",member.name));
      const shifts = state.data.shifts.filter(shift => member.id ? shift.member_ids.includes(member.id) : !shift.member_ids.length);
      label.append(el("small","helper",hours(shifts.reduce((total,shift) => total + duration(shift.start,shift.end),0)))); tr.append(label);
      for(let day=0;day<7;day++) {
        const date = addDays(state.week,day), cell = el("td",date === today() ? "scheduler-today" : "");
        shifts.filter(shift => localParts(shift.start).slice(0,10) <= date && localParts(new Date(new Date(shift.end).getTime()-1)).slice(0,10) >= date).forEach(shift => {
          const card = button("",() => editShift(shift),"scheduler-shift");
          card.dataset.color = colours.find(([value]) => value === shift.color)?.[1].toLowerCase() || "blue";
          card.classList.toggle("scheduler-draft",!shift.published);
          card.append(el("strong","",`${timeFormatter.format(new Date(shift.start))} – ${timeFormatter.format(new Date(shift.end))}`),el("span","",shift.title));
          if (shift.project_id) card.append(el("small","",shift.project_name || state.projects.find(project => project.id === shift.project_id)?.title || shift.project_id));
          if (!shift.published) card.append(el("small","scheduler-draft-label","Draft")); cell.append(card);
        });
        if (admin()) { const add = button("+",() => editShift(null,date,member.id),"scheduler-add"); add.setAttribute("aria-label",`Add shift for ${member.name} on ${date}`); cell.append(add); }
        tr.append(cell);
      }
      body.append(tr);
    });
    table.append(body); scroll.append(table); state.root.append(scroll);
    if (state.data.members.length === 0) state.root.append(el("p","helper","Add your team in Team members, then select a day to schedule a shift."));
  }
  function editShift(shift = null,date = today(),memberId = "") {
    if (!admin()) {
      const modal = el("dialog","scheduler-dialog"); modal.append(el("h2","",shift.title),el("p","",`${dateFormatter.format(new Date(shift.start))} – ${dateFormatter.format(new Date(shift.end))}`),el("p","",shift.location || ""),el("p","",shift.notes || ""),button("Close",() => modal.close())); state.root.append(modal); modal.addEventListener("close",() => modal.remove()); modal.showModal(); return;
    }
    dialog(shift ? "Edit shift" : "Add shift",host => {
      const title = input("text",shift?.title || "",{required:true,maxlength:200});
      const start = input("datetime-local",shift ? localParts(shift.start) : `${date}T07:00`,{required:true});
      const end = input("datetime-local",shift ? localParts(shift.end) : `${date}T15:30`,{required:true});
      const color = select(colours,shift?.color || "#2196f3");
      const project = projectSelect(shift || {}), location = input("text",shift?.location || "",{maxlength:400});
      const notes = el("textarea"); notes.value = shift?.notes || ""; notes.maxLength = 2000;
      const members = el("fieldset","scheduler-members"); members.append(el("legend","","Team members"));
      const selected = new Set(shift?.member_ids || (memberId ? [memberId] : []));
      const memberChecks = state.data.members.filter(item => item.active || selected.has(item.id)).map(member => {
        const item = check(member.name,selected.has(member.id)); members.append(item.label); return {id:member.id,control:item.control};
      });
      const publish = check("Published",shift?.published ?? true);
      host.append(field("Title",title),field("Colour",color),field("Start",start,"Australia/Sydney"),field("End",end,"Australia/Sydney"),members,field("Job / project reference",project),field("Location",location),field("Notes",notes),publish.label);
      if (shift) host.append(button("Delete shift",() => {
        if (window.confirm(`Delete “${shift.title}” from the schedule?`)) request("/shifts/delete",{id:shift.id,version:shift.version}).then(() => {closeDialog(); refresh();}).catch(error => notice(error.message,true));
      },"button secondary scheduler-danger"));
      return {title,start,end,color,project,location,notes,publish,memberChecks};
    },"Save shift",async controls => {
      await request("/shifts/save",{...(shift ? {id:shift.id,version:shift.version} : {}),title:controls.title.value,
        start:controls.start.value,end:controls.end.value,color:controls.color.value,
        project_id:controls.project.value,project_name:projectName(controls.project),location:controls.location.value,notes:controls.notes.value,published:controls.publish.control.checked,
        member_ids:controls.memberChecks.filter(item => item.control.checked).map(item => item.id)});
    });
  }
  function renderTeam() {
    const heading = el("div","section-heading"); heading.append(el("h2","","Team members"),button("Add team member",() => editMember(),"button")); state.root.append(heading);
    const list = el("div","scheduler-team");
    state.data.members.forEach(member => {const card = el("section","card"); card.append(el("h3","",member.name),el("p","helper",member.email),el("p","helper",`${member.role === "admin" ? "Administrator" : "Team member"} · ${member.active ? "Active" : "Inactive"}`),button("Edit member",() => editMember(member))); list.append(card);});
    state.root.append(list);
  }
  function editMember(member = null) {
    dialog(member ? "Edit team member" : "Add team member",host => {
      const name = input("text",member?.name || "",{required:true,maxlength:120}), email = input("email",member?.email || "",{required:true,maxlength:254,autocomplete:"off"});
      const password = input("password","",{minlength:12,maxlength:128,autocomplete:"new-password"}); password.required = !member;
      const rate = input("number",member?.base_rate ?? "0",{min:0,max:10000,step:"0.01",required:true});
      const role = select([["worker","Team member"],["admin","Administrator"]],member?.role || "worker"), active = check("Active",member?.active ?? true);
      host.append(field("Name",name),field("Email / sign-in",email),field(member ? "New password" : "Password",password,member ? "Leave empty to keep the current password." : "At least 12 characters."),field("Base hourly rate (AUD)",rate),field("Role",role),active.label);
      return {name,email,password,rate,role,active};
    },"Save member",async controls => request("/members/save",{...(member ? {id:member.id,version:member.version} : {}),name:controls.name.value,email:controls.email.value,
      ...(controls.password.value ? {password:controls.password.value} : {}),base_rate:controls.rate.value,role:controls.role.value,active:controls.active.control.checked}));
  }
  function renderEntries() {
    const controls = weekControls(); if (admin()) controls.append(button("Add time entry",() => editEntry(),"button")); state.root.append(controls);
    const scroll = el("div","table-scroll"), table = el("table","scheduler-entries"), head = el("thead"), row = el("tr");
    ["Team member","Start / finish","Job","Worked","Breaks","Actions"].forEach(label => row.append(el("th","",label))); head.append(row); table.append(head);
    const body = el("tbody");
    state.data.entries.forEach(entry => {
      const row = el("tr"), interval = el("td"); interval.append(el("div","",dateFormatter.format(new Date(entry.start))),el("small","helper",entry.end ? dateFormatter.format(new Date(entry.end)) : "Clocked in"));
      const unpaid = (entry.breaks || []).filter(item => !item.paid).reduce((total,item) => total + duration(item.start,item.end || entry.end),0);
      const breaks = (entry.breaks || []).reduce((total,item) => total + duration(item.start,item.end || entry.end),0);
      row.append(el("td","",memberName(entry.member_id)),interval,el("td","",entry.project_name || state.projects.find(project => project.id === entry.project_id)?.title || entry.project_id || "—"),el("td","",hours(Math.max(0,duration(entry.start,entry.end)-unpaid))),el("td","",hours(breaks)));
      const actions = el("td","scheduler-row-actions"); if (admin() && entry.end) actions.append(button("Edit",() => editEntry(entry)));
      if (entry.member_id === state.data.user.id) actions.append(button("Locations",() => showLocations(entry))); row.append(actions); body.append(row);
    });
    table.append(body); scroll.append(table); state.root.append(scroll);
    if (!state.data.entries.length) state.root.append(el("p","empty-state","No time entries for this week."));
    const pay = state.data.payroll;
    if (pay) {
      const card = el("section","card scheduler-payroll"); card.append(el("h2","","Pay breakdown"));
      if (pay.message) card.append(el("p","helper",pay.message));
      const money = value => new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD"}).format(value);
      for (const item of pay.rows || []) {
        const detail = el("details"), summary = el("summary","scheduler-pay-row");
        summary.append(el("strong","",memberName(item.member_id)),el("span","",`${item.hours} hours`),el("span","",money(item.gross))); detail.append(summary);
        for (const segment of item.segments || []) {
          const line = el("p","scheduler-pay-row"); line.append(el("span","",`${dateFormatter.format(new Date(segment.start))} – ${timeFormatter.format(new Date(segment.end))}`),el("span","",`${segment.multiplier}× · ${(segment.rules || []).join(", ") || "Ordinary"}`),el("span","",money(segment.amount))); detail.append(line);
        }
        card.append(detail);
      }
      state.root.append(card);
    }
  }
  function editEntry(entry = null) {
    dialog(entry ? "Edit time entry" : "Add time entry",host => {
      const member = select(state.data.members.map(item => [item.id,item.name]),entry?.member_id || state.data.user.id);
      const start = input("datetime-local",entry ? localParts(entry.start) : `${today()}T07:00`,{required:true});
      const end = input("datetime-local",entry ? localParts(entry.end) : `${today()}T15:30`,{required:true});
      const project = projectSelect(entry || {}), notes = el("textarea"); notes.value = entry?.notes || ""; notes.maxLength = 2000;
      host.append(field("Team member",member),field("Start",start,"Australia/Sydney"),field("Finish",end,"Australia/Sydney"),field("Job / project reference",project),field("Notes / reason for correction",notes));
      const breakList = el("div","scheduler-break-editor"), breakRows = [];
      function addBreak(item = {}) {
        const row = el("div","scheduler-break-row"), from = input("datetime-local",item.start ? localParts(item.start) : "",{required:true}), to = input("datetime-local",item.end ? localParts(item.end) : "",{required:true}), paid = check("Paid",!!item.paid);
        const record = {row,from,to,paid}; breakRows.push(record);
        row.append(field("Break start",from),field("Break end",to),paid.label,button("Remove",() => {breakRows.splice(breakRows.indexOf(record),1); row.remove();})); breakList.append(row);
      }
      (entry?.breaks || []).forEach(addBreak); host.append(el("h3","","Breaks"),breakList,button("Add break",() => addBreak()));
      if (entry) host.append(button("Delete time entry",() => {
        if (window.confirm("Delete this time entry? The audit history is retained.")) request("/entries/delete",{id:entry.id,version:entry.version}).then(() => {closeDialog(); refresh();}).catch(error => notice(error.message,true));
      },"button secondary scheduler-danger"));
      return {member,start,end,project,notes,breakRows};
    },"Save time entry",async controls => request("/entries/save",{...(entry ? {id:entry.id,version:entry.version} : {}),member_id:controls.member.value,
      start:controls.start.value,end:controls.end.value,project_id:controls.project.value,project_name:projectName(controls.project),notes:controls.notes.value,
      breaks:controls.breakRows.map(item => ({start:item.from.value,end:item.to.value,paid:item.paid.control.checked}))}));
  }
  function renderSettings() {
    const saved = state.data.settings, form = el("form","card scheduler-settings");
    form.append(el("h2","","Scheduler settings"),el("p","helper","All schedules and pay days use Australia/Sydney. Recorded timestamps are retained when rounding settings change."));
    const rounding = select([["0","No rounding"],...([5,6,10,15,30].map(value => [String(value),`${value} minutes`]))],String(saved.rounding_minutes));
    const mode = select([["nearest","Nearest interval"],["up","Round up"],["down","Round down"]],saved.rounding_mode);
    form.append(field("Timesheet rounding",rounding),field("Rounding method",mode));
    const breakRows = [], breakList = el("div","scheduler-break-editor");
    function addBreak(item = {name:"",minutes:30,paid:false}) {
      const row = el("div","scheduler-break-row"), name = input("text",item.name,{required:true,maxlength:80}), minutes = input("number",item.minutes,{min:1,max:240,step:1,required:true}), paid = check("Paid",item.paid);
      const record = {row,name,minutes,paid}; breakRows.push(record);
      row.append(field("Break name",name),field("Suggested minutes",minutes),paid.label,button("Remove",() => {breakRows.splice(breakRows.indexOf(record),1); row.remove();})); breakList.append(row);
    }
    saved.breaks.forEach(addBreak); form.append(el("h3","","Break options"),el("p","helper","Breaks are started and ended by the team member. These options do not automatically deduct time."),breakList,button("Add break option",() => addBreak()));
    form.append(el("h3","","Overtime and penalty rules"));
    const rules = el("ul","scheduler-rule-list");
    ["Daily overtime · after 8 hours, 1.5× · after 10 hours, 2×","Saturday · first 2 hours, 1.5× · subsequent hours, 2×","Sunday · all hours, 2×","Afternoon shift · starts 1 pm–3 pm, 1.5× for the whole shift","Night shift · starts 3 pm–11 pm, 1.5× for the whole shift","Weekly overtime · after 40 hours, 1.5×"].forEach(rule => rules.append(el("li","",rule)));
    form.append(rules,el("p","helper","The highest applicable multiplier is used. All worked hours count toward the weekly threshold. Paid breaks remain paid and unpaid breaks are excluded."));
    const submit = el("button","button","Save settings"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit",async event => {event.preventDefault(); submit.disabled = true; try {
      await request("/settings",{...saved,rounding_minutes:Number(rounding.value),rounding_mode:mode.value,breaks:breakRows.map(item => ({name:item.name.value,minutes:Number(item.minutes.value),paid:item.paid.control.checked}))}); await refresh(); notice("Scheduler settings saved.");
    } catch (error) {notice(error.message,true);} finally {submit.disabled = false;}});
    state.root.append(form);
  }
  function stopLocation() {
    if (state.watch !== null) navigator.geolocation?.clearWatch(state.watch);
    state.watch = null; state.locationEnabled = false;
    try {sessionStorage.removeItem("classifire-scheduler-location-entry");} catch (_) { /* Storage may be unavailable. */ }
  }
  function startLocation() {
    if (!state.data?.active_entry?.location_consent) {state.locationEnabled = false; return;}
    if (!navigator.geolocation) {notice("Location is unavailable in this browser.",true); state.locationEnabled = false; return;}
    stopLocation(); state.locationEnabled = true; state.lastLocation = 0;
    const entryId = state.data.active_entry.id;
    try {sessionStorage.setItem("classifire-scheduler-location-entry",entryId);} catch (_) { /* Storage may be unavailable. */ }
    state.watch = navigator.geolocation.watchPosition(async position => {
      if (!state.locationEnabled || state.data?.active_entry?.id !== entryId || Date.now() - state.lastLocation < 60000) return;
      state.lastLocation = Date.now();
      try {await request("/locations",{latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,captured_at:new Date(position.timestamp).toISOString()});}
      catch (error) {notice(error.message,true); stopLocation();}
    },error => {stopLocation(); notice(error.code === 1 ? "Location permission was declined. Your time clock continues to run." : "Your location is temporarily unavailable. You can retry location recording.",true);},
    {enableHighAccuracy:true,maximumAge:30000,timeout:20000});
  }
  async function showLocations(entry) {
    try {
      const data = await request(`/locations?entry_id=${encodeURIComponent(entry.id)}`);
      closeDialog(); const modal = el("dialog","scheduler-dialog scheduler-locations"), title = el("h2","","Your location history");
      modal.append(title,el("p","helper",`${dateFormatter.format(new Date(entry.start))} · Recorded accuracy is shown for each pin.`));
      const locations = data.locations || [];
      if (!locations.length) modal.append(el("p","empty-state","No locations were recorded for this time entry."));
      else {
        const map = el("div","scheduler-location-map"); map.append(locationPlot(locations),el("p","helper","Coordinate trail · North is up · Open a pin link for a street map.")); modal.append(map);
        const list = el("ol","scheduler-location-list"); locations.forEach(point => {
          const row = el("li"), link = el("a","",`${dateFormatter.format(new Date(point.captured_at))} · ${Number(point.latitude).toFixed(5)}, ${Number(point.longitude).toFixed(5)} · ±${Math.round(point.accuracy)} m`);
          link.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(point.latitude)}&mlon=${encodeURIComponent(point.longitude)}#map=17/${encodeURIComponent(point.latitude)}/${encodeURIComponent(point.longitude)}`;
          link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); list.append(row);
        }); modal.append(list);
      }
      modal.append(button("Close",closeDialog)); modal.addEventListener("close",() => {modal.remove(); if(state.dialog === modal)state.dialog = null;}); state.root.append(modal); state.dialog = modal; modal.showModal();
    } catch(error) {notice(error.message,true);}
  }
  function locationPlot(points) {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns,"svg"); svg.setAttribute("viewBox","0 0 640 320"); svg.setAttribute("role","img"); svg.setAttribute("aria-label",`Location trail with ${points.length} recorded pins`);
    const cos = Math.cos(Number(points[0].latitude) * Math.PI / 180), xs = points.map(point => Number(point.longitude) * cos), ys = points.map(point => Number(point.latitude));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), scale = Math.min(560 / Math.max(maxX-minX,0.0001),240 / Math.max(maxY-minY,0.0001));
    const coords = xs.map((value,index) => [320 + (value-(minX+maxX)/2)*scale,160 - (ys[index]-(minY+maxY)/2)*scale]);
    const line = document.createElementNS(ns,"polyline"); line.setAttribute("points",coords.map(pair => pair.join(",")).join(" ")); line.setAttribute("class","scheduler-location-line"); svg.append(line);
    coords.forEach(([x,y],index) => {const group = document.createElementNS(ns,"g"), circle = document.createElementNS(ns,"circle"), label = document.createElementNS(ns,"text"); circle.setAttribute("cx",x); circle.setAttribute("cy",y); circle.setAttribute("r","12"); label.setAttribute("x",x); label.setAttribute("y",y+4); label.textContent = index+1; group.append(circle,label); svg.append(group);}); return svg;
  }
  async function activate() {
    state.root ||= document.getElementById("scheduler-root"); if(!state.root)return;
    if (state.data?.user) return refresh();
    shell(); notice("Loading Scheduler…");
    try { await loadProjects(); } catch(error) {notice(error.message,true);}
    try { const bootstrap = await request("/bootstrap"); if (bootstrap.user) await refresh(); else auth(bootstrap.setup_required); }
    catch(error) {notice(error.message,true);}
    if (!state.timer) state.timer = setInterval(() => {
      if (state.data?.user && !state.root.closest("[hidden]") && !state.dialog && !state.busy && state.page !== "settings") refresh();
    },60000);
  }
  window.CeasefireScheduler = {activate,init(options = {}) {state.root = options.root || document.getElementById("scheduler-root");},hasPendingOperation() {return state.busy || !!state.dialog;}};
})();
