(() => {
  "use strict";
  let zone = "Australia/Sydney";
  const LOCATION_INTERVAL = 30 * 60 * 1000;
  const state = {root:null, data:null, page:"schedule", week:weekStart(today()), member:"", mine:false,
    loading:0, busy:false, dialog:null, watch:null, lastLocation:0, locationEnabled:false, timer:null, orders:[], settingsDirty:false,
    projectsLoading:false, projectsScan:null, projectsMessage:"", breakNotices:new Set(), noticeTimer:null,
    locationTimer:null, locationEntry:null, locationPending:false, lastPoint:null, locationIssue:"", locationHealth:0, trackingBanner:null,
    entriesSearch:"", entriesMine:false, collapsedDays:new Set(), locationPlayback:null, authGeneration:0, mapRequest:0};
  const accountChannel = "BroadcastChannel" in window ? new BroadcastChannel("classifire-scheduler-account") : null;
  const colours = [["#2196f3","Blue"],["#b12030","Red"],["#177349","Green"],["#7544a8","Purple"],["#505966","Grey"]];
  let dayFormatter, dateFormatter, timeFormatter, clockFormatter;
  const calendarDay = new Intl.DateTimeFormat("en-AU", {timeZone:"UTC",weekday:"short",day:"numeric",month:"short"});
  function setZone(value) {
    if (!value || (zone === value && clockFormatter)) return;
    const currentWeek = weekStart(today());
    zone = value;
    dayFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:zone,weekday:"short",day:"numeric",month:"short"});
    dateFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:zone,day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});
    timeFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:zone,hour:"numeric",minute:"2-digit"});
    clockFormatter = new Intl.DateTimeFormat("en-AU", {timeZone:zone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
    if (state.week === currentWeek) state.week = weekStart(today());
    renderHeaderTime();
  }
  setZone(zone);
  function renderHeaderTime() {
    const clock = document.getElementById("scheduler-local-time");
    if (!clock || clock.closest("[hidden]")) return;
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = clockFormatter.format(now) + " · " + zone;
  }
  function el(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }
  function button(text, action, className = "button secondary") {
    const result = el("button", className, text); result.type = "button";
    if (text === "+") {
      const symbol = el("span", "button-symbol add-symbol", "+");
      symbol.setAttribute("aria-hidden", "true"); result.replaceChildren(symbol);
    }
    result.addEventListener("click", action); return result;
  }
  function addIconButton(label, action, extraClass = "") {
    const result = button("+", action, "button primary icon-only penetration-new-item-action" + (extraClass ? " " + extraClass : ""));
    result.title = label; result.setAttribute("aria-label", label);
    window.CeasefireI18n?.attr(result, "title", label);
    window.CeasefireI18n?.attr(result, "aria-label", label);
    return result;
  }
  function input(type, value = "", attributes = {}) {
    const result = el("input"); result.type = type; result.value = value;
    if (type === "datetime-local") result.step = "1";
    Object.entries(attributes).forEach(([key, val]) => result.setAttribute(key, String(val))); return result;
  }
  function field(label, control, hint) {
    const result = el("label", "field"); result.append(el("span", "", label), control);
    const labelled = control.querySelector?.(".scheduler-order-search") || control;
    labelled.setAttribute("aria-label",label);
    if (labelled.id) result.htmlFor = labelled.id;
    if (hint) {result.append(el("small", "helper", hint)); control.setAttribute("aria-description",hint);} return result;
  }
  function select(options, value) {
    const result = el("select");
    options.forEach(([id,label]) => { const option = el("option", "", label); option.value = id; result.append(option); });
    result.value = value; return result;
  }
  function shiftColours(current) {
    const group = el("fieldset","scheduler-colours"), legend = el("legend","",translated("Colour"));
    legend.id = "scheduler-colour-label";
    group.setAttribute("role","radiogroup"); group.setAttribute("aria-labelledby",legend.id);
    group.append(legend);
    const choices = el("div","scheduler-colour-choices");
    // Older shifts can hold any valid six-digit colour, including one outside the current palette.
    const options = colours.some(([value]) => value === current.toLowerCase()) ? colours : [...colours,[current,"Current colour"]];
    for (const [value,name] of options) {
      const tile = el("label","scheduler-colour-tile"), label = el("span","",translated(name));
      const checked = value.toLowerCase() === current.toLowerCase();
      const radio = input("radio",checked ? current : value,{name:"scheduler-shift-colour"});
      radio.checked = checked;
      const swatch = el("span","scheduler-colour-swatch");
      swatch.setAttribute("aria-hidden","true");
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      const rect = document.createElementNS(svg.namespaceURI,"rect");
      rect.setAttribute("width","100%"); rect.setAttribute("height","100%"); rect.setAttribute("fill",value);
      svg.append(rect);
      swatch.append(svg,el("span","scheduler-colour-check","✓"));
      tile.append(radio,swatch,label); choices.append(tile);
    }
    group.append(choices);
    return group;
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
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));
    const values = Object.fromEntries(parts.map(part => [part.type,part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
  }
  function duration(start,end) { return Math.max(0, (new Date(end || Date.now()) - new Date(start)) / 60000); }
  function editedTime(control, original) { return original && control.value === localParts(original) ? original : control.value; }
  function hours(minutes) { const rounded = Math.round(minutes); return `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2,"0") }m`; }
  function memberName(id) { return state.data.members.find(member => member.id === id)?.name || "Unassigned"; }
  function admin() { return state.data?.user?.role === "admin"; }
  const translated = (source,args=[])=>window.CeasefireI18n?.translate(source,args) || source.replace(/\{(\d+)\}/g,(_,i)=>args[Number(i)] ?? '');
  function orderLabel(order) {
    return [order.reference, order.project_no, order.client, order.site_address, translated(order.status), `v${order.version}`].filter(Boolean).join(' · ');
  }
  function orderShiftTitle(order) {
    return [order?.client,order?.site_address].map(value => (value || '').replace(/\s+/g,' ').trim()).filter(Boolean).join(': ').slice(0,200).replace(/[\uD800-\uDBFF]$/,'');
  }
  function assignmentLabel(record) {
    const legacy=record.project_name || record.project_id;
    return record.work_order ? orderLabel(record.work_order) : legacy ? translated('{0} (legacy project)',[legacy]) : '';
  }
  function orderSelect(record = {}) {
    const held = record.work_order;
    const key = order => order.id + '@' + order.revision;
    const current = held ? key(held) : record.project_id || record.project_name ? 'legacy' : '';
    const wrapper = el('div','searchable-choice scheduler-order-choice');
    const search = input('search','',{autocomplete:'off',spellcheck:'false'});
    search.id = 'scheduler-order-' + crypto.randomUUID();search.className = 'scheduler-order-search';
    search.placeholder = translated('Search Work Orders');
    const list = el('div','searchable-choice-list'), popup = el('div','searchable-choice-popup'), status = el('div','helper');
    list.id = search.id + '-choices';list.setAttribute('role','listbox');list.setAttribute('aria-label',translated('{0} choices',[translated('Work Order')]));
    search.setAttribute('role','combobox');search.setAttribute('aria-controls',list.id);
    search.setAttribute('aria-autocomplete','list');search.setAttribute('aria-expanded','false');
    const toggle = button('⌄',() => {const wasOpen=!popup.hidden;search.focus();if(wasOpen)close();else open('');},'searchable-choice-toggle');
    toggle.tabIndex = -1;toggle.setAttribute('aria-label',translated('Show {0} choices',[translated('Work Order')]));
    toggle.addEventListener('pointerdown',event => event.preventDefault());
    status.setAttribute('role','status');popup.hidden = true;popup.append(list,status);wrapper.append(search,toggle,popup);
    let chosen = current, chosenOrder = held || null, committedText = '', matches = [], active = -1;
    const listeners = [];
    function options() {
      const choices = [{value:'',label:translated('No Work Order assigned'),order:null},
        ...state.orders.map(order => ({value:key(order),label:orderLabel(order),order}))];
      if(current && !choices.some(item => item.value === current))choices.push({value:current,
        label:held ? translated('{0} (saved assignment)',[assignmentLabel(record)]) : assignmentLabel(record),order:held || null});
      return choices;
    }
    function close() {popup.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');active=-1;}
    function commit(item) {
      chosen=item.value;chosenOrder=item.order;committedText=chosen ? item.label : '';search.value=committedText;
      search.setCustomValidity('');close();listeners.forEach(run=>run());
    }
    function highlight(index) {
      active=index;
      [...list.children].forEach((option,i)=>option.setAttribute('aria-selected',String(i===active)));
      if(active>=0){const item=list.children[active];search.setAttribute('aria-activedescendant',item.id);item.scrollIntoView({block:'nearest'});}
    }
    function open(query=search.value) {
      // Re-read the bounded, permission-filtered server choices when searching;
      // late background loading never replaces this form or commits a choice.
      const needle=query.trim().toLocaleLowerCase();
      const found=options().filter(item=>item.label.toLocaleLowerCase().includes(needle));
      matches=found.slice(0,80);active=-1;
      list.replaceChildren(...matches.map((item,index)=>{
        const option=el('div','',item.label);option.id=list.id+'-'+index;option.tabIndex=-1;
        option.setAttribute('role','option');option.setAttribute('aria-selected','false');
        // Mouse keeps combobox focus; touch remains free to scroll the list.
        // Activation belongs to click, including assistive-technology clicks.
        option.addEventListener('pointerdown',event=>{if(event.pointerType!=='touch')event.preventDefault();});
        option.addEventListener('click',()=>{search.focus();commit(item);});return option;
      }));
      status.textContent=translated(!found.length ? 'No matching Work Orders.' : found.length>matches.length ? '{0} matches. Type more to narrow the list.' : '{0} choices',[found.length]);
      popup.hidden=false;search.setAttribute('aria-expanded','true');search.removeAttribute('aria-activedescendant');
    }
    search.addEventListener('input',()=>{
      if(!search.value){chosen='';chosenOrder=null;committedText='';search.setCustomValidity('');listeners.forEach(run=>run());}
      else search.setCustomValidity(translated('Choose a listed Work Order or clear the search.'));
      open();
    });
    search.addEventListener('focus',()=>{open(search.value===committedText ? '' : search.value);void loadOrders();});
    wrapper.addEventListener('scheduler-orders-updated',()=>{if(!popup.hidden)open(search.value===committedText ? '' : search.value);});
    search.addEventListener('blur',event=>{if(!wrapper.contains(event.relatedTarget))close();});
    search.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();event.stopPropagation();if(popup.hidden)open(search.value===committedText?'':search.value);
        if(matches.length)highlight(Math.max(0,Math.min(matches.length-1,active+(event.key==='ArrowDown'?1:-1))));
      }else if(event.key==='Enter'&&!popup.hidden){
        event.preventDefault();event.stopPropagation();
        if(active>=0)commit(matches[active]);else if(matches.length===1)commit(matches[0]);
      }else if(event.key==='Escape'&&(!popup.hidden||search.value!==committedText)){
        event.preventDefault();event.stopPropagation();search.value=committedText;search.setCustomValidity('');close();
      }
    });
    const initial=options().find(item=>item.value===current);committedText=current ? initial.label : '';search.value=committedText;
    return {element:wrapper,original:current,value:()=>chosen,order:()=>chosenOrder,onChange:run=>listeners.push(run)};
  }
  function selectedOrder(control) {
    if (control.value() === control.original) return {};
    if (!control.value()) return {work_order:null};
    const {id, revision} = control.order();
    return {work_order:{id, revision}};
  }
  function orderStatus() {
    state.root?.querySelectorAll('.scheduler-order-choice').forEach(control => control.dispatchEvent(new Event('scheduler-orders-updated')));
  }
  async function loadOrders() {
    if (state.projectsLoading || !state.data?.user) return;
    const current = accountAction();
    state.projectsLoading = true;
    if (!state.projectsScan || state.projectsScan.complete) state.projectsScan = {offset:0,records:new Map(),complete:false};
    const scan = state.projectsScan, deadline = Date.now() + 30000;
    state.projectsMessage = translated("Loading Work Order choices in the background…");
    orderStatus();
    try {
      for (let page = 0; page < 20 && Date.now() < deadline; page++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(),Math.min(5000,deadline-Date.now()));
        let data;
        try {
          const response = await fetch(`/api/scheduler/work-orders?offset=${scan.offset}`,{credentials:"same-origin",cache:"no-store",headers:{"X-Scheduler-Member":state.data.user.id},signal:controller.signal});
          if (!response.ok) throw new Error("Work Order list unavailable");
          data = await response.json();
        } finally {clearTimeout(timeout);}
        if (!current()) return;
        for (const order of data.orders || []) scan.records.set(order.id,order);
        if (!data.scan_pending) {
          scan.offset += (data.orders || []).length;
          scan.complete = !data.orders?.length || scan.offset >= (data.matched ?? scan.offset);
        }
        const choices = scan.complete ? new Map() : new Map(state.orders.map(order => [order.id,order]));
        for (const [id,project] of scan.records) choices.set(id,project);
        state.orders = [...choices.values()];
        state.projectsMessage = translated("{0} Work Orders available",[state.orders.length]);
        if(data.error_count) state.projectsMessage += ' '+translated('Some saved sources are unavailable.');
        orderStatus();
        if (scan.complete) break;
        await new Promise(resolve => setTimeout(resolve,500));
      }
      if (!scan.complete) state.projectsMessage = translated("{0} Work Order choices available. Continue loading to scan more files.",[state.orders.length]);
    } catch (_) {
      if (!current()) return;
      state.projectsMessage = translated("Work Order choices are taking longer to load. Continue loading to retry. You can still use Scheduler.");
    } finally {
      if(current()){state.projectsLoading = false;orderStatus();}
    }
  }
  function notice(message, error = false) {
    const host = state.root?.querySelector(".scheduler-notice"); if (!host) return;
    host.textContent = message; host.classList.toggle("error",error); host.hidden = !message;
  }
  async function request(path, payload) {
    const headers = {"Content-Type":"application/json"};
    if (state.data?.user?.id && !["/login","/setup","/bootstrap","/state"].includes(path.split("?")[0])) headers["X-Scheduler-Member"] = state.data.user.id;
    const response = await fetch(`/api/scheduler${path}`, {credentials:"same-origin", cache:"no-store",headers,
      ...(payload === undefined ? {} : {method:"POST",body:JSON.stringify(payload)})});
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The Scheduler request could not be completed."); error.status = response.status; throw error;
    }
    return data;
  }
  async function refresh() {
    const revision = ++state.loading, generation = state.authGeneration;
    try {
      const data = await request(`/state?start=${state.week}&end=${addDays(state.week,7)}`);
      if (revision !== state.loading || generation !== state.authGeneration) return;
      if (state.locationEntry && (state.data?.user?.id !== data.user?.id || state.locationEntry !== data.active_entry?.id)) stopLocation();
      if (state.data?.user && (state.data.user.id !== data.user?.id || state.data.user.role !== data.user?.role)) resetAccount();
      state.data = data;
      if (!state.projectsScan) void loadOrders();
      const previousWeek = state.week;
      setZone(data.settings.timezone);
      if (previousWeek !== state.week) return refresh();
      if (!data.active_entry) stopLocation();
      else if (state.locationEntry !== data.active_entry.id) startLocation();
      updateLocationStatus();
      if (state.dialog || state.settingsDirty) return;
      render();
    } catch (error) {
      if (revision !== state.loading || generation !== state.authGeneration) return;
      if (error.status === 401) {resetAccount(); auth(false);}
      notice(error.message, true);
    }
  }
  function resetAccount() {
    state.authGeneration++; state.loading++; state.mapRequest++;
    closeDialog(true); stopLocation(); state.data = null; state.settingsDirty = false;
    state.busy = false; state.orders=[]; state.projectsScan=null; state.projectsLoading=false; state.projectsMessage="";
    state.page = "schedule"; state.member = ""; state.mine = false; state.entriesSearch = ""; state.entriesMine = false;
    updateLocationStatus();
  }
  function accountAction() {
    // Keep async intent and completion bound to the sign-in that started them.
    const generation = state.authGeneration, member = state.data?.user?.id;
    return () => !!member && generation === state.authGeneration && member === state.data?.user?.id;
  }
  async function mutate(path,payload) {
    if (state.busy) return;
    const current = accountAction();
    state.busy = true;
    try { await request(path,payload); if(current()) await refresh(); }
    catch (error) { if(current()) notice(error.message,true); }
    finally { if(current()) state.busy = false; }
  }
  function shell() {
    state.root.replaceChildren();
    const heading = el("div","page-heading"); const clock = el("time","scheduler-local-time"); clock.id = "scheduler-local-time";
    heading.append(el("h1","","Scheduler"),clock); state.root.append(heading); renderHeaderTime();
    const status = el("p", "scheduler-notice message"); status.setAttribute("role","status"); status.hidden = true;
    state.root.append(status);
  }
  function closeDialog(force = false) { if(state.busy && force !== true)return; clearInterval(state.locationPlayback); state.locationPlayback = null; state.dialog?.close(); state.dialog?.remove(); state.dialog = null; }
  function dialog(title, build, saveLabel, save, submitClass = "button", draftLabel = "") {
    closeDialog();
    const modal = el("dialog", "scheduler-dialog"), form = el("form", "scheduler-form");
    const heading = el("div", "section-heading");
    const titleNode = el("h2", "", title); titleNode.id = "scheduler-dialog-title";
    modal.setAttribute("aria-labelledby",titleNode.id);
    heading.append(titleNode,button("Close",closeDialog));
    const content = el("div", "scheduler-form-fields"), error = el("p", "message error"); error.hidden = true; error.setAttribute("role","alert");
    const controls = build(content), actions = el("div", "actions scheduler-dialog-actions");
    const submit = el("button", submitClass, saveLabel); submit.type = "submit";
    actions.append(button("Cancel",closeDialog));
    let draft;
    if (draftLabel) {
      submit.value = "publish";
      draft = el("button","button secondary scheduler-secondary-submit",draftLabel);
      draft.type = "submit"; draft.value = "draft"; actions.append(draft);
      // A browser can treat Enter in a text field as a click on the first submit
      // button. Publishing or withdrawing a shift requires activating its action.
      form.addEventListener("keydown",event => {
        if (event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement) event.preventDefault();
      });
    }
    actions.append(submit);
    form.append(heading,content,error,actions); modal.append(form);
    modal.addEventListener("close", () => { modal.remove(); if (state.dialog === modal) state.dialog = null; });
    modal.addEventListener("cancel", event => {if(state.busy)event.preventDefault();});
    form.addEventListener("submit",async event => {
      event.preventDefault(); if (state.busy || submit.disabled || state.dialog !== modal) return;
      if (draft && event.submitter !== submit && event.submitter !== draft) return;
      const current = accountAction(); state.busy = true; error.hidden = true;
      form.querySelectorAll("button").forEach(button => button.disabled = true);
      try { await save(controls,event.submitter?.value); if(!current() || state.dialog !== modal)return; closeDialog(true); await refresh(); }
      catch (failure) { if(current() && state.dialog === modal) {error.textContent = failure.message; error.hidden = false;} }
      finally { if(current()) {state.busy = false; form.querySelectorAll("button").forEach(button => button.disabled = false);} }
    });
    state.root.append(modal); state.dialog = modal; modal.showModal();
    return modal;
  }
  async function deleteRecord(path,payload,prompt) {
    if(state.busy || !window.confirm(prompt))return;
    const modal = state.dialog, current = accountAction(); state.busy = true;
    modal?.querySelectorAll("button").forEach(button => button.disabled = true);
    try {await request(path,payload); if(!current() || state.dialog !== modal)return; closeDialog(true); await refresh();}
    catch(error) {if(current() && state.dialog === modal) {const feedback = modal?.querySelector('[role="alert"]'); if(feedback) {feedback.textContent = error.message; feedback.hidden = false;} else notice(error.message,true);}}
    finally {if(current()) {state.busy = false; modal?.querySelectorAll("button").forEach(button => button.disabled = false);}}
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
      resetAccount();
      try { await request(setup ? "/setup" : "/login",{...(setup ? {name:name.value} : {}),email:email.value,password:password.value}); password.value = ""; accountChannel?.postMessage("changed"); await refresh(); }
      catch (error) { notice(error.message,true); } finally { submit.disabled = false; }
    });
    card.append(form); state.root.append(card);
  }
  function render() {
    if (!state.data?.user) return auth(false);
    const clockFocused = document.activeElement === state.root.querySelector(".scheduler-clock");
    shell();
    const top = el("div", "scheduler-top"), tabs = el("nav", "calculator-pages scheduler-tabs"); tabs.setAttribute("aria-label","Scheduler pages");
    const pages = [["schedule","Schedule"],["entries","Time entries"],...(admin() ? [["team","Team members"],["settings","Settings"]] : [])];
    pages.forEach(([id,label]) => {
      const tab = button(label,() => {
        if (state.busy || state.settingsDirty) {notice("Finish saving or discard your settings changes before changing pages.",true); return;}
        state.page = id; render();
      }, "calculator-page"); tab.setAttribute("aria-pressed", String(state.page === id)); tab.setAttribute("aria-current",state.page === id ? "page" : "false"); tabs.append(tab);
    });
    const account = el("div", "scheduler-account"); account.append(el("span","",state.data.user.name),button("Sign out",async () => {
      if (state.busy || state.settingsDirty) {notice("Finish saving or discard your settings changes before signing out.",true); return;}
      const logout = request("/logout",{}); resetAccount(); shell(); notice("Signing out…");
      try { const result=await logout; accountChannel?.postMessage("changed"); if(result.global_session){location.replace('/');return;} auth(false); }
      catch (error) {await refresh(); notice(error.message,true);}
    })); top.append(tabs,account); state.root.append(top);
    renderClock();
    if (clockFocused && !state.root.closest("[hidden]")) state.root.querySelector(".scheduler-clock").focus({preventScroll:true});
    if (state.page === "schedule") renderSchedule();
    if (state.page === "entries") renderEntries();
    if (state.page === "team" && admin()) renderTeam();
    if (state.page === "settings" && admin()) renderSettings();
  }
  function renderClock() {
    const active = state.data.active_entry, bar = el("section", "scheduler-clock card"); bar.setAttribute("aria-label","Your time clock"); bar.tabIndex = -1;
    const summary = el("div"); summary.append(el("strong","",active ? "You are clocked in" : "Your time clock"));
    if (active) summary.append(el("p","helper",`Started ${dateFormatter.format(new Date(active.start))} · ${hours(duration(active.start))}`));
    else summary.append(el("p","helper",`Record your working time in ${zone}.`));
    bar.append(summary);
    if (active) {
      const openBreak = active.breaks?.find(item => !item.end);
      const available = state.data.settings.breaks.filter(rule => rule.manual && (!rule.member_ids.length || rule.member_ids.includes(state.data.user.id)));
      if (openBreak) {
        bar.append(button("End break",() => mutate("/clock/break",{entry_id:active.id,version:active.version,action:"end",paid:openBreak.paid})));
      } else if (available.length && (active.breaks || []).length < 50) {
        bar.append(button("Start break",() => dialog("Start a break",host => {
          const choices = available.map(item => [item.id,`${item.name} · ${item.minutes === null ? "no set length" : `${item.minutes} min`} · ${item.paid ? "paid" : "unpaid"}`]);
          const kind = select(choices,choices[0][0]); kind.required = true;
          host.append(field("Break",kind),el("p","helper","Minimum duration and automatic end settings follow the selected break rule.")); return {kind};
        },"Start break",async ({kind}) => request("/clock/break",{entry_id:active.id,version:active.version,action:"start",rule_id:kind.value}))));
      }
      if (openBreak?.expected_end_at) bar.append(el("p","helper",`${openBreak.name || "Break"} · expected end ${timeFormatter.format(new Date(openBreak.expected_end_at))}${openBreak.min_end_at ? " · minimum duration required" : ""}${openBreak.auto_end_at ? " · ends automatically" : ""}`));
      if (openBreak?.notify_at && "Notification" in window && Notification.permission !== "granted") bar.append(button("Enable break notifications",async () => {await Notification.requestPermission(); render();}));
      bar.append(button("Check location now",() => {void captureLocation(true);},"button secondary scheduler-location-retry"));
      bar.append(button("Clock out",async event => {
        const control = event.currentTarget; if (control.disabled || state.busy) return; control.disabled = true; state.busy = true;
        const current = accountAction();
        // A failed final fix must never trap a worker in an open time entry.
        try {
          await Promise.race([captureLocation(true,2000),new Promise(resolve => setTimeout(resolve,2200))]);
          if(!current())return;
          await request("/clock/out",{entry_id:active.id});
          if(!current())return;
          await refresh(); if(current() && !state.data?.active_entry) stopLocation();
        }
        catch(error) {if(current())notice(error.message,true);}
        finally {if(current()) {control.disabled = false; state.busy = false;}}
      },"button scheduler-add-action"));
      bar.append(el("p","helper scheduler-clock-note",openBreak ? "You are on a break. Shift location recording remains active." : "Location recording is required throughout this shift."));
      const tracking = el("p","helper scheduler-location-status"); tracking.setAttribute("role","status"); bar.append(tracking);
    } else bar.append(button("Clock in",() => dialog("Clock in",host => {
      const project = orderSelect(), notes = el("textarea"); notes.maxLength = 2000;
      host.append(field(translated("Work Order"),project.element),field("Notes",notes),el("p","message scheduler-location-required","Location is required to clock in. Your location is recorded during the shift, including a check every 30 minutes. You and your administrator can view the history."),el("p","helper","Allow location access when your browser asks. Keep CLASSIFIRE open and this computer awake. Missing updates are shown as gaps; they cannot be recovered after the browser was closed or suspended.")); return {project,notes};
    },"Clock in",async ({project,notes}) => {
      const current = accountAction();
      const location = await currentPosition();
      if(!current())return;
      const entry = await request("/clock/in",{...selectedOrder(project),notes:notes.value,location_consent:true,location});
      if(!current())return;
      state.data.active_entry = entry;
      state.lastLocation = Date.now(); state.lastPoint = location;
      startLocation();
    },"button scheduler-primary-action"),"button scheduler-primary-action"));
    bar.addEventListener("click",event => {
      if(state.settingsDirty) {event.stopImmediatePropagation(); notice("Save or discard your settings changes before using the time clock.",true);}
    },true);
    state.root.append(bar);
    updateLocationStatus();
  }
  function checkBreakNotification() {
    const entry = state.data?.active_entry, item = entry?.breaks?.find(value => !value.end);
    if (!item?.notify_at || !item.expected_end_at) return;
    const key = `${entry.id}/${item.start}`, now = Date.now();
    if (now < Date.parse(item.notify_at) || now >= Date.parse(item.expected_end_at) || state.breakNotices.has(key)) return;
    state.breakNotices.add(key);
    const text = `${item.name || "Your break"} ends at ${timeFormatter.format(new Date(item.expected_end_at))}.`;
    notice(text);
    if ("Notification" in window && Notification.permission === "granted") new Notification("Break ending soon",{body:text});
  }
  function weekControls() {
    const controls = el("div", "scheduler-toolbar");
    const date = input("date",state.week,{"aria-label":"Week containing date"});
    date.addEventListener("change",() => { if (date.value) { state.week = weekStart(date.value); refresh(); } });
    controls.append(button("Today",() => {state.week = weekStart(today()); refresh();}),button("←",() => {state.week = addDays(state.week,-7); refresh();}),date,button("→",() => {state.week = addDays(state.week,7); refresh();}));
    controls.children[1].setAttribute("aria-label","Previous week"); controls.children[3].setAttribute("aria-label","Next week");
    controls.append(el("strong", "scheduler-week",`${calendarDay.format(new Date(`${state.week}T12:00:00Z`))} – ${calendarDay.format(new Date(`${addDays(state.week,6)}T12:00:00Z`))}`));
    return controls;
  }
  function renderSchedule() {
    const controls = weekControls();
    const filter = select([["","All team members"],...state.data.members.filter(item => item.active).map(item => [item.id,item.name])],state.member);
    filter.setAttribute("aria-label","Filter team members"); filter.addEventListener("change",() => {state.member = filter.value; render();}); controls.append(filter);
    const mine = check("My schedule",state.mine); mine.control.addEventListener("change",() => {state.mine = mine.control.checked; render();}); controls.append(mine.label);
    if (admin()) controls.append(addIconButton("Add shift",() => editShift(),"scheduler-primary-action scheduler-toolbar-add"));
    state.root.append(controls,el("p","helper",`Week view · ${zone} · Select a shift for details.`));
    const scroll = el("div", "scheduler-grid-scroll"), table = el("table", "scheduler-grid"); table.append(el("caption", "sr-only","Weekly schedule by team member"));
    const head = el("thead"), row = el("tr"); row.append(el("th","scheduler-person","Team member"));
    for(let day=0;day<7;day++) { const date = addDays(state.week,day), cell = el("th",date === today() ? "scheduler-today" : "",calendarDay.format(new Date(`${date}T12:00:00Z`))); cell.scope = "col"; row.append(cell); }
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
          const colour = /^#[0-9a-f]{6}$/i.test(shift.color || '') ? shift.color : '#2196f3';
          card.dataset.color = colours.find(([value]) => value === shift.color)?.[1].toLowerCase() || 'blue';
          card.style.setProperty('--scheduler-shift-colour',colour.toLowerCase()==='#2196f3' ? '#1767b2' : colour);
          card.classList.toggle("scheduler-draft",!shift.published);
          card.append(el("strong","",`${timeFormatter.format(new Date(shift.start))} – ${timeFormatter.format(new Date(shift.end))}`),el("span","",shift.title));
          if (assignmentLabel(shift)) card.append(el("small","",assignmentLabel(shift)));
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
    const inputZone = zone, requestId = shift ? null : crypto.randomUUID();
    void loadOrders();
    if (!admin()) {
      const modal = el("dialog","scheduler-dialog"); modal.append(el("h2","",shift.title),el("p","",`${dateFormatter.format(new Date(shift.start))} – ${dateFormatter.format(new Date(shift.end))}`),el("p","",shift.location || ""),el("p","",shift.notes || ""),button("Close",() => modal.close())); state.root.append(modal); modal.addEventListener("close",() => modal.remove()); modal.showModal(); return;
    }
    const editor = dialog(shift ? "Edit shift" : "Add shift",host => {
      const title = input("text",shift?.title || orderShiftTitle(shift?.work_order),{required:true,maxlength:200});
      const start = input("datetime-local",shift ? localParts(shift.start) : `${date}T07:00`,{required:true});
      const end = input("datetime-local",shift ? localParts(shift.end) : `${date}T15:30`,{required:true});
      const color = shiftColours(shift?.color || "#2196f3");
      const initialProject = shift?.work_order;
      const project = orderSelect(shift || {}), location = input("text",shift?.location || initialProject?.site_address || "",{maxlength:400});
      let titleOrder = project.order()?.id || '';
      project.onChange(() => {
        const selected = project.order(), nextOrder = selected?.id || '';
        if (selected) {
          location.value = selected.site_address || "";
          if (nextOrder !== titleOrder) title.value = orderShiftTitle(selected);
        }
        titleOrder = nextOrder;
      });
      const notes = el("textarea"); notes.value = shift?.notes || ""; notes.maxLength = 2000;
      const members = el("fieldset","scheduler-members"); members.append(el("legend","","Team members"));
      const selected = new Set(shift?.member_ids || (memberId ? [memberId] : []));
      const memberChecks = state.data.members.filter(item => item.active || selected.has(item.id)).map(member => {
        const item = check(member.name,selected.has(member.id)); members.append(item.label); return {id:member.id,control:item.control};
      });
      host.append(field("Title",title),color,field("Start",start,zone),field("End",end,zone),members,field(translated("Work Order"),project.element),field("Location",location),field("Notes",notes));
      if (shift) host.append(button("Delete shift",() => {
        deleteRecord("/shifts/delete",{id:shift.id,version:shift.version},`Delete “${shift.title}” from the schedule?`);
      },"button secondary scheduler-danger"));
      return {title,start,end,color,project,location,notes,memberChecks};
    },translated("Publish shift"),async (controls,intent) => {
      await request("/shifts/save",{input_timezone:inputZone,...(shift ? {id:shift.id,version:shift.version} : {request_id:requestId}),title:controls.title.value,
        start:editedTime(controls.start,shift?.start),end:editedTime(controls.end,shift?.end),color:controls.color.querySelector("input:checked").value,
        ...selectedOrder(controls.project),location:controls.location.value,notes:controls.notes.value,published:intent === "publish",
        member_ids:controls.memberChecks.filter(item => item.control.checked).map(item => item.id)});
    },"button scheduler-primary-action",translated("Create draft"));
    editor.classList.add("scheduler-shift-editor");
  }
  function renderTeam() {
    const heading = el("div","section-heading"); heading.append(el("h2","","Team members"),addIconButton("Add team member",() => editMember(),"scheduler-primary-action scheduler-toolbar-add")); state.root.append(heading);
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
    const controls = weekControls(); if (admin()) controls.append(addIconButton("Add time entry",() => editEntry(),"scheduler-primary-action scheduler-toolbar-add"));
    const search = input("search",state.entriesSearch,{"aria-label":"Search time entries",placeholder:"Team member, job or notes"});
    controls.append(search);
    if (admin()) for (const [mine,label] of [[true,"My"],[false,"All"]]) {
      const toggle = button(label,() => {state.entriesMine = mine; render();}); toggle.setAttribute("aria-pressed",String(state.entriesMine === mine)); controls.append(toggle);
    }
    state.root.append(el("h2","scheduler-entries-title","Time Entries"),controls);
    const scroll = el("div","table-scroll"), table = el("table","scheduler-entries"), head = el("thead"), row = el("tr");
    ["Name","Time in – out","Duration","Job","Location","Notes","Actions"].forEach(label => row.append(el("th","",label))); head.append(row); table.append(head);
    const body = el("tbody");
    const empty = el("p","empty-state","No time entries match this week and filter.");
    const drawRows = () => {
      body.replaceChildren();
      const term = state.entriesSearch.trim().toLocaleLowerCase();
      const entries = state.data.entries.filter(entry => (!state.entriesMine || entry.member_id === state.data.user.id) && (!term || [memberName(entry.member_id),assignmentLabel(entry),entry.notes].join(" ").toLocaleLowerCase().includes(term)));
      const segments = entries.flatMap(entry => entrySegments(entry).map(segment => ({...segment,entry})));
      segments.sort((a,b) => b.start.localeCompare(a.start) || memberName(a.entry.member_id).localeCompare(memberName(b.entry.member_id)));
      let day = "";
      for (const segment of segments) {
        const entry = segment.entry, date = localParts(segment.start).slice(0,10);
        if (date !== day) {
          day = date; const group = el("tr","scheduler-entry-day"), cell = el("th"); cell.colSpan = 7;
          const toggle = button(calendarDay.format(new Date(`${date}T12:00:00Z`)),() => {state.collapsedDays.has(date) ? state.collapsedDays.delete(date) : state.collapsedDays.add(date); drawRows();},"scheduler-day-toggle");
          toggle.setAttribute("aria-expanded",String(!state.collapsedDays.has(date))); cell.append(toggle); group.append(cell); body.append(group);
        }
        const row = el("tr",segment.break ? "scheduler-entry-break" : "scheduler-entry-work"); row.hidden = state.collapsedDays.has(date); row.dataset.entryId = entry.id;
        const interval = el("td","scheduler-entry-time",`${timeFormatter.format(new Date(segment.start))} – ${segment.end ? timeFormatter.format(new Date(segment.end)) : "Clocked in"}`);
        if (segment.end && localParts(segment.end).slice(0,10) !== date) interval.append(el("small","helper",dayFormatter.format(new Date(segment.end))));
        const job = el("td");
        if (segment.break) {
          job.append(el("span","scheduler-break-badge",segment.break.name || "Break"),el("small","helper",`${segment.break.paid ? "Paid" : "Unpaid"}${segment.break.automatic ? " · automatic" : ""}`));
          const detail = el("details","scheduler-break-summary"); detail.append(el("summary","","Break details"),el("p","",`${segment.break.name || "Break"} · ${segment.break.paid ? "paid" : "unpaid"}${segment.break.automatic ? " · automatic" : ""}`)); job.append(detail);
        } else job.textContent = assignmentLabel(entry) || "—";
        const location = el("td");
        if (!segment.break && (admin() || entry.member_id === state.data.user.id)) {
          const count = entry.location_summary?.count || 0, action = button(count ? `⌖ Web app · ${count} pins` : "⌖ No locations",() => showLocations(entry),"text-button scheduler-location-link");
          action.setAttribute("aria-label",`Locations for ${memberName(entry.member_id)}, ${dateFormatter.format(new Date(entry.start))}`); location.append(action);
        } else location.textContent = "—";
        const actions = el("td","scheduler-row-actions"); if(admin() && entry.end && !segment.break) actions.append(button("Edit",() => editEntry(entry)));
        row.append(el("td","",memberName(entry.member_id)),interval,el("td","",hours(duration(segment.start,segment.end))),job,location,el("td","scheduler-entry-notes",segment.break ? "" : entry.notes || "—"),actions); body.append(row);
      }
      empty.hidden = segments.length > 0;
    };
    search.addEventListener("input",() => {state.entriesSearch = search.value; drawRows();}); drawRows();
    table.append(body); scroll.append(table); state.root.append(scroll);
    state.root.append(empty,el("p","helper","Timesheets are grouped by day. Breaks appear as separate rows. Location history shows recorded observations and any missing intervals."));
    const pay = state.data.payroll;
    if (pay) {
      const card = el("section","card scheduler-payroll"); card.append(el("h2","","Pay breakdown"));
      if (pay.rules_version) card.append(el("p","helper",`Rule version ${pay.rules_version}`));
      if (pay.message) card.append(el("p","helper",pay.message));
      for (const warning of pay.break_warnings || []) card.append(el("p","message error",warning.message));
      const money = value => new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD"}).format(value);
      for (const item of pay.rows || []) {
        const detail = el("details"), summary = el("summary","scheduler-pay-row");
        summary.append(el("strong","",memberName(item.member_id)),el("span","",`${item.hours} hours`),el("span","",money(item.gross))); detail.append(summary);
        for (const segment of item.segments || []) {
          const line = el("p","scheduler-pay-row"); line.append(el("span","",`${dateFormatter.format(new Date(segment.start))} – ${timeFormatter.format(new Date(segment.end))}`),el("span","",`${segment.multiplier}× · ${(segment.rules || []).join(", ") || "Ordinary"}${segment.pay_items?.length ? ` · ${segment.pay_items.join(", ")}` : ""}`),el("span","",money(segment.amount))); detail.append(line);
        }
        card.append(detail);
      }
      state.root.append(card);
    }
  }
  function entrySegments(entry) {
    const finish = entry.end || new Date().toISOString(), segments = [];
    let cursor = entry.start;
    for (const item of [...(entry.effective_breaks || entry.breaks || [])].sort((a,b) => a.start.localeCompare(b.start))) {
      if (item.start > cursor) segments.push({start:cursor,end:item.start});
      const end = item.end || finish; segments.push({start:item.start,end:item.end ? end : null,break:item}); cursor = end;
    }
    if (cursor < finish || !segments.length) segments.push({start:cursor,end:entry.end ? finish : null});
    return segments;
  }
  function editEntry(entry = null) {
    const inputZone = zone;
    dialog(entry ? "Edit time entry" : "Add time entry",host => {
      const member = select(state.data.members.map(item => [item.id,item.name]),entry?.member_id || state.data.user.id);
      const start = input("datetime-local",entry ? localParts(entry.start) : `${today()}T07:00`,{required:true});
      const end = input("datetime-local",entry ? localParts(entry.end) : `${today()}T15:30`,{required:true});
      const project = orderSelect(entry || {}), notes = el("textarea"); notes.value = entry?.notes || ""; notes.maxLength = 2000;
      host.append(field("Team member",member),field("Start",start,zone),field(translated("Work Order"),project.element),field("Finish",end,zone),field("Notes / reason for correction",notes));
      const breakList = el("div","scheduler-break-editor"), breakRows = [];
      function addBreak(item = {}) {
        const row = el("div","scheduler-break-row"), from = input("datetime-local",item.start ? localParts(item.start) : "",{required:true}), to = input("datetime-local",item.end ? localParts(item.end) : "",{required:true}), paid = check("Paid",!!item.paid);
        const record = {row,from,to,paid,original:item}; breakRows.push(record);
        row.append(field("Break start",from),field("Break end",to),paid.label,button("Remove",() => {breakRows.splice(breakRows.indexOf(record),1); row.remove();})); breakList.append(row);
      }
      (entry?.breaks || []).forEach(addBreak); host.append(el("h3","","Breaks"),breakList,button("Add break",() => addBreak()));
      if (entry) host.append(button("Delete time entry",() => {
        deleteRecord("/entries/delete",{id:entry.id,version:entry.version},"Delete this time entry? The audit history is retained.");
      },"button secondary scheduler-danger"));
      return {member,start,end,project,notes,breakRows};
    },"Save time entry",async controls => request("/entries/save",{input_timezone:inputZone,...(entry ? {id:entry.id,version:entry.version} : {}),member_id:controls.member.value,
      start:editedTime(controls.start,entry?.start),end:editedTime(controls.end,entry?.end),...selectedOrder(controls.project),notes:controls.notes.value,
      breaks:controls.breakRows.map(item => ({start:editedTime(item.from,item.original.start),end:editedTime(item.to,item.original.end),paid:item.paid.control.checked}))}));
  }
  function dayChoices(selected, label) {
    const fieldset = el("fieldset","scheduler-days"); fieldset.append(el("legend","",label));
    const choices = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((name,day) => {
      const choice = check(name,selected.includes(day)); fieldset.append(choice.label); return choice.control;
    });
    return {element:fieldset, value:() => choices.flatMap((control,day) => control.checked ? [day] : [])};
  }
  function renderSettings() {
    const saved = state.data.settings, form = el("form","card scheduler-settings");
    form.append(el("h2","","Scheduler settings"),el("p","helper",`${zone} · Rule version ${saved.version}. Saved rules recalculate time entries using their recorded hourly rates.`));
    const rounding = select([["0","No rounding"],...([5,6,10,15,30].map(value => [String(value),`${value} minutes`]))],String(saved.rounding_minutes));
    const mode = select([["nearest","Nearest interval"],["up","Round up"],["down","Round down"]],saved.rounding_mode);
    form.append(field("Timesheet rounding",rounding),field("Rounding method",mode));
    const overtimeRows = [], overtimeList = el("div","scheduler-rule-editors");
    function addOvertime(item = {id:crypto.randomUUID(),name:"",type:"daily",days:[0,1,2,3,4,5,6],threshold_hours:"8",multiplier:"1.5",pay_item:"",start_time:"13:00",end_time:"15:00",run_late:false,enabled:true}) {
      const row = el("details","scheduler-rule-editor"), summary = el("summary","",item.name || "New overtime rule");
      row.open = !item.name; row.append(summary);
      const grid = el("div","scheduler-rule-fields"), name = input("text",item.name,{required:true,maxlength:120});
      const type = select([["daily","Daily"],["weekly","Weekly"],["time","Time of day"]],item.type);
      const threshold = input("number",item.threshold_hours,{min:0,max:168,step:"0.01",required:true});
      const multiplier = input("number",item.multiplier,{min:1,max:10,step:"0.01",required:true});
      const payItem = input("text",item.pay_item,{maxlength:120}), days = dayChoices(item.days,"Days of the week");
      const from = input("time",item.start_time,{required:true}), to = input("time",item.end_time,{required:true});
      const runLate = check("Allow shift to run late",item.run_late), enabled = check("Enabled",item.enabled);
      const thresholdField = field("Start after hours",threshold), windowFields = el("div","scheduler-rule-window");
      windowFields.append(field("From",from),field("To",to),runLate.label,el("p","helper","Allowing a shift to run late applies the rate to the whole shift when its start falls in this window."));
      grid.append(field("Rule name",name),field("Type",type),days.element,thresholdField,windowFields,field("Rate multiplier",multiplier),field("Pay item label",payItem),enabled.label);
      const record = {value:() => ({id:item.id,name:name.value,type:type.value,days:days.value(),threshold_hours:threshold.value,multiplier:multiplier.value,pay_item:payItem.value,start_time:from.value,end_time:to.value,run_late:runLate.control.checked,enabled:enabled.control.checked})};
      grid.append(button("Delete overtime rule",() => {overtimeRows.splice(overtimeRows.indexOf(record),1); row.remove(); state.settingsDirty = true;},"button secondary scheduler-danger"));
      const sync = () => {summary.textContent = name.value || "New overtime rule"; thresholdField.hidden = type.value === "time"; windowFields.hidden = type.value !== "time";};
      name.addEventListener("input",sync); type.addEventListener("change",sync); sync();
      row.append(grid); overtimeRows.push(record); overtimeList.append(row);
    }
    saved.overtime_rules.forEach(addOvertime);
    form.append(el("h3","","Overtime and penalty rules"),el("p","helper","The highest matching multiplier applies. All paid hours count toward weekly thresholds. Days and weeks start at midnight, with Monday starting the week."),overtimeList,addIconButton("Add overtime rule",() => {addOvertime(); state.settingsDirty = true;}));
    const breakRows = [], breakList = el("div","scheduler-rule-editors");
    function addBreakRule(item = {id:crypto.randomUUID(),name:"",code:"",minutes:15,paid:false,member_ids:[],automatic:false,after_hours:"4",repeat_hours:null,days:[0,1,2,3,4],placement:"middle",manual:true,auto_end:false,minimum:false,notify_minutes:0}) {
      const row = el("details","scheduler-rule-editor"), summary = el("summary","",item.name || "New break rule"); row.open = !item.name; row.append(summary);
      const grid = el("div","scheduler-rule-fields"), name = input("text",item.name,{required:true,maxlength:80}), code = input("text",item.code,{maxlength:20});
      const minutes = input("number",item.minutes ?? 15,{min:1,max:180,step:1,required:true}), noLength = check("No set length",item.minutes === null);
      const paid = select([["false","Unpaid"],["true","Paid"]],String(item.paid));
      const all = check("All team members",!item.member_ids.length), members = select(state.data.members.map(member => [member.id,member.name]),""); members.multiple = true;
      [...members.options].forEach(option => {option.selected = item.member_ids.includes(option.value);});
      const automatic = check("Apply breaks automatically",item.automatic), after = input("number",item.after_hours,{min:0.01,max:168,step:"0.01",required:true});
      const repeat = check("Repeat",item.repeat_hours !== null), repeatHours = input("number",item.repeat_hours ?? 4,{min:0.01,max:168,step:"0.01",required:true});
      const days = dayChoices(item.days,"Automatic break days"), placement = select([["middle","Middle of shift"],["after_threshold","At each threshold"]],item.placement);
      const autoFields = el("div","scheduler-rule-section"); autoFields.append(field("Shift has reached hours",after),repeat.label,field("Repeat every hours",repeatHours),days.element,field("Place break",placement));
      const manual = check("Team members can start and stop this break",item.manual), autoEnd = check("End automatically when its set length is reached",item.auto_end), minimum = check("Require the full break duration before ending",item.minimum);
      const notify = input("number",item.notify_minutes,{min:0,max:179,step:1,required:true});
      const manualFields = el("div","scheduler-rule-section"); manualFields.append(autoEnd.label,minimum.label,field("Notify minutes before break ends",notify,"0 turns notifications off. Browser notifications need permission and an open browser."));
      grid.append(field("Break name",name),field("Short code",code),field("Length in minutes",minutes),noLength.label,field("Type",paid),all.label,field("Apply to team members",members),automatic.label,autoFields,manual.label,manualFields);
      const record = {value:() => ({id:item.id,name:name.value,code:code.value,minutes:noLength.control.checked ? null : Number(minutes.value),paid:paid.value === "true",member_ids:all.control.checked ? [] : [...members.selectedOptions].map(option => option.value),automatic:!noLength.control.checked && automatic.control.checked,after_hours:after.value,repeat_hours:repeat.control.checked ? repeatHours.value : null,days:days.value(),placement:placement.value,manual:manual.control.checked,auto_end:!noLength.control.checked && autoEnd.control.checked,minimum:!noLength.control.checked && minimum.control.checked,notify_minutes:noLength.control.checked ? 0 : Number(notify.value)})};
      grid.append(button("Delete break rule",() => {breakRows.splice(breakRows.indexOf(record),1); row.remove(); state.settingsDirty = true;},"button secondary scheduler-danger"));
      const sync = () => {summary.textContent = name.value || "New break rule"; minutes.disabled = noLength.control.checked; members.disabled = all.control.checked; members.required = !all.control.checked; automatic.control.disabled = noLength.control.checked; autoFields.hidden = noLength.control.checked || !automatic.control.checked; repeatHours.disabled = !repeat.control.checked; manualFields.hidden = !manual.control.checked; autoEnd.control.disabled = minimum.control.disabled = notify.disabled = noLength.control.checked;};
      for (const control of [name,noLength.control,all.control,automatic.control,repeat.control,manual.control]) control.addEventListener("change",sync);
      sync(); row.append(grid); breakRows.push(record); breakList.append(row);
    }
    saved.breaks.forEach(addBreakRule);
    form.append(el("h3","","Break rules"),el("p","helper","Automatic breaks are calculated when a time entry is complete. Thresholds use elapsed shift time. Repeated middle breaks are spaced evenly. A matching manual break satisfies one automatic break, and breaks never overlap."),breakList,addIconButton("Add break rule",() => {addBreakRule(); state.settingsDirty = true;}));
    const submit = el("button","button scheduler-primary-action","Save settings"); submit.type = "submit";
    const discard = button("",() => {state.settingsDirty = false; render();},"button secondary icon-only");
    discard.title = "Discard settings changes"; discard.setAttribute("aria-label","Discard settings changes");
    window.CeasefireI18n?.text(submit,"Save settings");
    window.CeasefireI18n?.attr(discard,"title","Discard settings changes");
    window.CeasefireI18n?.attr(discard,"aria-label","Discard settings changes");
    const resetIcon = document.createElementNS("http://www.w3.org/2000/svg","svg");
    for (const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true",focusable:"false"})) resetIcon.setAttribute(key,value);
    for (const d of ["M20 7v5h-5","M4 17v-5h5","M6.1 8.4A7.5 7.5 0 0 1 19.2 10L20 12","M17.9 15.6A7.5 7.5 0 0 1 4.8 14L4 12"]) {const path = document.createElementNS("http://www.w3.org/2000/svg","path"); path.setAttribute("d",d); resetIcon.append(path);}
    discard.append(resetIcon); const actions = el("div","actions scheduler-settings-actions"); actions.append(submit,discard); form.append(actions);
    form.addEventListener("input",() => {state.settingsDirty = true;}); form.addEventListener("change",() => {state.settingsDirty = true;});
    form.addEventListener("submit",async event => {
      event.preventDefault(); if (state.busy) return; state.busy = true;
      const current = accountAction();
      const controls = [...form.querySelectorAll("input,select,button")].map(control => [control,control.disabled]);
      controls.forEach(([control]) => {control.disabled = true;});
      try {await request("/settings",{...saved,rounding_minutes:Number(rounding.value),rounding_mode:mode.value,overtime_rules:overtimeRows.map(row => row.value()),breaks:breakRows.map(row => row.value())}); if(!current())return; state.settingsDirty = false; await refresh(); if(current())notice("Scheduler settings saved.");}
      catch (error) {if(current())notice(error.message,true);} finally {if(current()) {state.busy = false; controls.forEach(([control,disabled]) => {control.disabled = disabled;});}}
    });
    state.root.append(form);
  }
  function stopLocation() {
    if (state.watch !== null) navigator.geolocation?.clearWatch(state.watch);
    clearInterval(state.locationTimer);
    state.watch = null; state.locationTimer = null; state.locationEnabled = false; state.locationEntry = null;
    state.lastPoint = null; state.lastLocation = 0; state.locationIssue = ""; state.locationHealth++;
    updateLocationStatus();
  }
  function locationFailure(message) {
    state.locationHealth++; state.locationIssue = message; updateLocationStatus();
  }
  function locationError(error) {
    if (error.code === 1) return "Location access is blocked. Enable location for CLASSIFIRE in your browser, then check location again.";
    if (error.code === 3) return "The location request timed out. Check this computer's location services and try again.";
    return error.message || "A location could not be obtained. Enable location services and try again.";
  }
  function positionValue(position) {
    const value = {latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,captured_at:new Date(position.timestamp).toISOString()};
    if (![value.latitude,value.longitude,value.accuracy].every(Number.isFinite) || Date.now()-position.timestamp > 120000 || position.timestamp > Date.now()+1000) throw new Error("The browser returned an old or invalid location. Obtain a new location and try again.");
    return value;
  }
  function currentPosition(timeout = 20000) {
    return new Promise((resolve,reject) => {
      if (!navigator.geolocation) return reject(new Error("Location is unavailable in this browser. Use a browser with location services enabled."));
      navigator.geolocation.getCurrentPosition(position => {
        try {resolve(positionValue(position));} catch(error) {reject(error);}
      },error => reject(new Error(locationError(error))),{enableHighAccuracy:true,maximumAge:0,timeout});
    });
  }
  async function openTimeClock(event) {
    const control = event.currentTarget;
    if (control.disabled) return;
    control.disabled = true;
    try {
      if (!await window.CeasefireProject?.openScheduler?.()) return;
      const clock = state.root?.querySelector(".scheduler-clock");
      if (!clock || state.root.closest("[hidden]")) return;
      clock.focus({preventScroll:true});
      const header = document.querySelector(".app-header");
      const offset = header?.getBoundingClientRect().bottom || 0;
      window.scrollTo({top:Math.max(0,window.scrollY + clock.getBoundingClientRect().top - offset - 12), behavior:"instant"});
    } catch (error) { notice(error.message, true); }
    finally { control.disabled = false; }
  }
  function updateLocationStatus() {
    const active = state.data?.active_entry;
    if (!state.trackingBanner && document.body) {
      state.trackingBanner = el("aside","scheduler-tracking-banner"); state.trackingBanner.setAttribute("aria-label","Shift location recording");
      state.trackingBanner.append(el("span","scheduler-tracking-text"),button("Open time clock",openTimeClock,"text-button"));
      document.body.append(state.trackingBanner);
    }
    const last = state.lastLocation || Date.parse(active?.location_summary?.last_at || "");
    const late = active && (!last || Date.now()-last > LOCATION_INTERVAL+5*60000);
    const text = !active ? "" : state.locationIssue ? `${state.locationIssue} Your clock continues; this gap will be visible in the history.` :
      `Location recording is on · checks every 30 minutes${last ? ` · last recorded ${timeFormatter.format(new Date(last))}` : " · obtaining first location"}${late ? " · update overdue" : ""}.`;
    if (state.trackingBanner) {
      state.trackingBanner.hidden = !active || !state.root?.closest("[hidden]");
      state.trackingBanner.classList.toggle("error",!!state.locationIssue || !!late);
      state.trackingBanner.querySelector(".scheduler-tracking-text").textContent = text;
    }
    const target = state.root?.querySelector(".scheduler-location-status");
    if (target) {target.textContent = text; target.classList.toggle("error",!!state.locationIssue || !!late);}
  }
  async function recordLocation(location, entryId, health = state.locationHealth) {
    if (!state.locationEnabled || state.locationEntry !== entryId || state.data?.active_entry?.id !== entryId) return false;
    const enable = !state.data.active_entry.location_consent;
    try {
      const result = await request(enable ? "/locations/enable" : "/locations",{entry_id:entryId,...location});
      if (state.locationEntry !== entryId || state.data?.active_entry?.id !== entryId) return false;
      const captured = Date.parse(result.captured_at || location.captured_at);
      if (captured >= state.lastLocation) {state.lastLocation = captured; state.lastPoint = location;}
      // Saving an earlier observation does not prove that location access is
      // still available after a newer browser/permission failure.
      if (health === state.locationHealth) state.locationIssue = "";
      if (enable) {state.data.active_entry.location_consent = true; void refresh();}
      updateLocationStatus(); return true;
    } catch(error) {
      if (state.locationEntry !== entryId || health !== state.locationHealth) return false;
      locationFailure(error.message);
      if ([401,403,409].includes(error.status)) {stopLocation(); void refresh();}
      updateLocationStatus(); return false;
    }
  }
  async function captureLocation(force = false, timeout = 20000) {
    if (!state.locationEnabled || !state.data?.active_entry || !force && !state.locationIssue && Date.now()-state.lastLocation < LOCATION_INTERVAL) return false;
    if (state.locationPending) return state.locationPending;
    const entryId = state.locationEntry, health = state.locationHealth;
    state.locationPending = (async () => {
      try {return await recordLocation(await currentPosition(timeout),entryId,health);}
      catch(error) {if (state.locationEntry === entryId && health === state.locationHealth) locationFailure(error.message); return false;}
      finally {state.locationPending = null;}
    })();
    return state.locationPending;
  }
  function startLocation() {
    const active = state.data?.active_entry; if (!active) return;
    const last = Date.parse(active.location_summary?.last_at || "") || state.lastLocation;
    stopLocation(); state.locationEnabled = true; state.locationEntry = active.id; state.lastLocation = last;
    const entryId = active.id;
    if (navigator.geolocation) state.watch = navigator.geolocation.watchPosition(position => {
      if (!state.locationEnabled || state.locationEntry !== entryId || state.locationPending || Date.now()-state.lastLocation < 60000) return;
      try {void recordLocation(positionValue(position),entryId);} catch(error) {locationFailure(error.message);}
    },error => {if(state.locationEntry === entryId) locationFailure(locationError(error));},
    {enableHighAccuracy:true,maximumAge:0,timeout:20000});
    else locationFailure("Location is unavailable in this browser.");
    // watchPosition alone need not fire when the device is stationary.
    // This independent timer obtains a fresh fix even without movement.
    state.locationTimer = setInterval(() => {void captureLocation(); updateLocationStatus();},60000);
    if (!last || Date.now()-last >= LOCATION_INTERVAL || !active.location_consent) void captureLocation(true);
    updateLocationStatus();
  }
  async function showLocations(entry) {
    const actor = state.data?.user?.id, generation = state.authGeneration, revision = ++state.mapRequest;
    try {
      const data = await request(`/locations?entry_id=${encodeURIComponent(entry.id)}`);
      if (actor !== state.data?.user?.id || generation !== state.authGeneration || revision !== state.mapRequest || state.page !== "entries") return;
      closeDialog(); const modal = el("dialog","scheduler-dialog scheduler-locations"), header = el("div","section-heading"), title = el("h2","",`Timesheet map for ${memberName(entry.member_id)}`);
      title.id = "scheduler-location-title"; modal.setAttribute("aria-labelledby",title.id); header.append(title,button("Close",closeDialog)); modal.append(header);
      const locations = data.locations || [];
      const layout = el("div","scheduler-location-layout"), mapColumn = el("div"), side = el("aside","scheduler-location-sidebar");
      const shifts = state.data.entries.filter(item => item.member_id === entry.member_id && localParts(item.start).slice(0,10) === localParts(entry.start).slice(0,10));
      const chooser = select(shifts.map(item => [item.id,`${timeFormatter.format(new Date(item.start))} – ${item.end ? timeFormatter.format(new Date(item.end)) : "Clocked in"}`]),entry.id);
      chooser.setAttribute("aria-label","Time entry for location history"); chooser.addEventListener("change",() => {const selected = shifts.find(item => item.id === chooser.value); if(selected) void showLocations(selected);});
      side.append(el("strong","",memberName(entry.member_id)),chooser,el("p","",dayFormatter.format(new Date(entry.start))),el("p","",hours(duration(entry.start,entry.end))),el("p","",assignmentLabel(entry) || translated("No Work Order assigned")),el("h3","","Timesheet timeline"));
      const list = el("ol","scheduler-location-list"), selectedText = el("p","scheduler-selected-location"); selectedText.setAttribute("aria-live","polite");
      let map, selectedIndex = 0;
      const selectPoint = index => {
        selectedIndex = index; const point = locations[index]; if(!point)return;
        map?.select(index);
        [...list.children].forEach((row,number) => row.querySelector("button")?.setAttribute("aria-current",number === index ? "true" : "false"));
        selectedText.textContent = `${dateFormatter.format(new Date(point.captured_at))} · ${Number(point.latitude).toFixed(5)}, ${Number(point.longitude).toFixed(5)} · accuracy ±${Math.round(point.accuracy)} m`;
      };
      if (!locations.length) mapColumn.append(el("p","empty-state","No locations were recorded for this time entry. Past movements cannot be reconstructed."));
      else {
        map = locationPlot(locations,selectPoint); mapColumn.append(map.element);
        const playback = button("Play route",() => {
          if(state.locationPlayback) {clearInterval(state.locationPlayback); state.locationPlayback = null; playback.textContent = "Play route"; return;}
          selectedIndex = -1; playback.textContent = "Pause route";
          const step = () => {selectPoint(selectedIndex+1); if(selectedIndex >= locations.length-1) {clearInterval(state.locationPlayback); state.locationPlayback = null; playback.textContent = "Play route";}};
          state.locationPlayback = setInterval(step,1000); step();
        },"button scheduler-add-action");
        mapColumn.append(playback,selectedText,el("p","helper","Map imagery from OpenStreetMap. Visible map tile coordinates are sent to OpenStreetMap; staff names, timestamps and sign-in details are not sent. Lines join recorded observations, not a verified driving route. Dashed lines indicate a gap longer than 35 minutes."));
        locations.forEach((point,index) => {
          const row = el("li"); row.append(button(`${index+1}. ${timeFormatter.format(new Date(point.captured_at))}`,() => selectPoint(index),"scheduler-timeline-point"),el("small","helper",`±${Math.round(point.accuracy)} m`)); list.append(row);
        });
      }
      side.append(list);
      const gaps = data.coverage?.gaps || [];
      if(gaps.length) {const warning = el("section","scheduler-location-gaps"); warning.append(el("strong","","Missing location intervals")); for(const gap of gaps) warning.append(el("p","helper",`${dateFormatter.format(new Date(gap.start))} – ${dateFormatter.format(new Date(gap.end))} · ${hours(gap.minutes)}`)); side.append(warning);}
      layout.append(mapColumn,side); modal.append(layout);
      modal.addEventListener("close",() => {clearInterval(state.locationPlayback); state.locationPlayback = null; map?.dispose(); modal.remove(); if(state.dialog === modal)state.dialog = null;}); state.root.append(modal); state.dialog = modal; modal.showModal(); selectPoint(0);
    } catch(error) {if(generation === state.authGeneration && revision === state.mapRequest) {notice(error.message,true); if([401,409].includes(error.status)) void refresh();}}
  }
  function locationPlot(points,onSelect) {
    const ns = "http://www.w3.org/2000/svg", wrapper = el("div","scheduler-location-map"), surface = el("div","scheduler-map-surface"), canvas = el("canvas"), svg = document.createElementNS(ns,"svg");
    canvas.width = 640; canvas.height = 420; canvas.setAttribute("aria-hidden","true"); svg.setAttribute("viewBox","0 0 640 420"); svg.setAttribute("role","img"); svg.setAttribute("aria-label",`Location trail with ${points.length} recorded pins`); surface.append(canvas,svg);
    const status = el("p","helper scheduler-map-status","Loading street map…"), controls = el("div","scheduler-map-controls");
    const project = point => {const latitude = Math.max(-85.0511,Math.min(85.0511,Number(point.latitude)))*Math.PI/180; return [(Number(point.longitude)+180)/360,(1-Math.log(Math.tan(latitude)+1/Math.cos(latitude))/Math.PI)/2];};
    const coords = points.map(project), xs = coords.map(point => point[0]), ys = coords.map(point => point[1]);
    const original = [(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2];
    const fitZoom = Math.max(1,Math.min(17,Math.floor(Math.log2(Math.min(530/(Math.max(...xs)-Math.min(...xs) || .00003)/256,320/(Math.max(...ys)-Math.min(...ys) || .00003)/256)))));
    let centre = [...original], zoom = fitZoom, selected = 0, revision = 0, disposed = false, dragging = null;
    const images = new Map(), context = canvas.getContext("2d");
    function draw(loadTiles = true) {
      if(disposed)return; revision++; const current = revision, size = 256*2**zoom, left = centre[0]*size-320, top = centre[1]*size-210;
      context.clearRect(0,0,640,420); svg.replaceChildren();
      const tileJobs = [];
      for(let y=Math.floor(top/256);y<=Math.floor((top+419)/256);y++) for(let x=Math.floor(left/256);x<=Math.floor((left+639)/256);x++) {
        if(y<0 || y>=2**zoom)continue;
        const column = ((x%2**zoom)+2**zoom)%2**zoom, key = `${zoom}/${column}/${y}`;
        let tile = images.get(key);
        if(!tile && loadTiles) {tile = new Image(); tile.referrerPolicy = "same-origin"; tile.src = `/api/scheduler/map-tile?z=${zoom}&x=${column}&y=${y}`; images.set(key,tile);}
        if(tile) tileJobs.push({tile,x:x*256-left,y:y*256-top});
      }
      if(images.size > 128) for(const [key,tile] of images) {if(images.size <= 128)break; if(!tileJobs.some(item => item.tile === tile)) {tile.onload = null; tile.onerror = null; images.delete(key);}}
      let failed = false;
      const paint = () => {
        if(disposed || current !== revision)return;
        context.clearRect(0,0,640,420);
        for(const item of tileJobs) if(item.tile.complete && item.tile.naturalWidth) context.drawImage(item.tile,item.x,item.y,256,256);
        failed = tileJobs.some(item => item.tile.complete && !item.tile.naturalWidth);
        status.textContent = failed ? "Street map unavailable. Recorded pins and coordinates remain available." : tileJobs.every(item => item.tile.complete) ? "OpenStreetMap · Drag to pan or use the zoom buttons." : "Loading street map…";
      };
      for(const item of tileJobs) {item.tile.onload = paint; item.tile.onerror = paint;} paint();
      const screen = coords.map(([x,y]) => [x*size-left,y*size-top]);
      for(let index=1;index<screen.length;index++) {
        const line = document.createElementNS(ns,"line"); line.setAttribute("x1",screen[index-1][0]); line.setAttribute("y1",screen[index-1][1]); line.setAttribute("x2",screen[index][0]); line.setAttribute("y2",screen[index][1]); line.setAttribute("class","scheduler-location-line");
        if(Date.parse(points[index].captured_at)-Date.parse(points[index-1].captured_at)>35*60000)line.setAttribute("stroke-dasharray","7 6"); svg.append(line);
      }
      screen.forEach(([x,y],index) => {const group = document.createElementNS(ns,"g"), circle = document.createElementNS(ns,"circle"), label = document.createElementNS(ns,"text"), title = document.createElementNS(ns,"title"); circle.setAttribute("cx",x); circle.setAttribute("cy",y); circle.setAttribute("r",index===selected ? "15" : "11"); circle.setAttribute("class",index===0 ? "scheduler-pin-start" : index===points.length-1 ? "scheduler-pin-end" : ""); label.setAttribute("x",x); label.setAttribute("y",y+4); label.textContent = index+1; title.textContent = `${timeFormatter.format(new Date(points[index].captured_at))} · ±${Math.round(points[index].accuracy)} m`; group.append(title,circle,label); group.addEventListener("click",() => onSelect(index)); svg.append(group);});
    }
    controls.append(button("+",() => {zoom=Math.min(19,zoom+1);draw();}),button("−",() => {zoom=Math.max(1,zoom-1);draw();}),button("Fit route",() => {centre=[...original];zoom=fitZoom;draw();})); controls.children[0].setAttribute("aria-label","Zoom in map"); controls.children[1].setAttribute("aria-label","Zoom out map");
    surface.addEventListener("pointerdown",event => {if(event.target.closest("g"))return; dragging={x:event.clientX,y:event.clientY,centre:[...centre]};surface.setPointerCapture(event.pointerId);});
    surface.addEventListener("pointermove",event => {if(!dragging)return;const scale=640/surface.getBoundingClientRect().width/(256*2**zoom);centre=[dragging.centre[0]-(event.clientX-dragging.x)*scale,Math.max(0,Math.min(1,dragging.centre[1]-(event.clientY-dragging.y)*scale))];draw(false);});
    const endDrag=()=>{if(dragging){dragging=null;draw();}};surface.addEventListener("pointerup",endDrag);surface.addEventListener("pointercancel",endDrag);
    const attribution=el("a","scheduler-map-attribution","© OpenStreetMap contributors");attribution.href="https://www.openstreetmap.org/copyright";attribution.target="_blank";attribution.rel="noopener noreferrer";
    wrapper.append(surface,controls,attribution,status);draw();
    return {element:wrapper,select(index){selected=index;draw(false);},dispose(){disposed=true;for(const tile of images.values()){tile.onload=null;tile.onerror=null;}}};
  }
  async function activate() {
    state.root ||= document.getElementById("scheduler-root"); if(!state.root)return;
    if (state.data?.user) await refresh();
    else {
      const generation = state.authGeneration;
      shell(); notice("Loading Scheduler…");
      try { const bootstrap = await request("/bootstrap"); if(generation !== state.authGeneration)return; setZone(bootstrap.timezone); if (bootstrap.user) await refresh(); else auth(bootstrap.setup_required); }
      catch(error) {if(generation === state.authGeneration)notice(error.message,true);}
    }
    if (state.data?.user && !state.projectsLoading) void loadOrders();
    beginPolling();
  }
  function beginPolling() {
    if (!state.timer) state.timer = setInterval(() => {
      if (state.data?.user && !state.busy && (state.data.active_entry || !state.root?.closest("[hidden]"))) {
        void refresh();
        if (!state.root?.closest("[hidden]")) void loadOrders();
      }
    },60000);
    if (!state.noticeTimer) state.noticeTimer = setInterval(() => {renderHeaderTime(); checkBreakNotification();},1000);
  }
  function initializeOrganizationSettings() {
    const form = document.getElementById("organization-timezone-form");
    if (!form) return;
    const picker = form.querySelector("select"), save = form.querySelector("button"), status = form.querySelector('[role="status"]');
    let version, saved, busy = false;
    function settingsNotice(source, error = false) {
      if (window.CeasefireI18n) window.CeasefireI18n.text(status, source);
      else status.textContent = source;
      status.className = error ? "message error" : "message info";
      window.CeasefireNotifications?.show(status);
      status.hidden = !source;
    }
    async function loadSettings() {
      if (busy) return;
      busy = true; picker.disabled = save.disabled = true;
      try {
        const settings = await request("/organization");
        picker.replaceChildren(...settings.zones.map(name => new Option(name, name)));
        saved = picker.value = settings.timezone;
        version = settings.version; status.textContent = ""; status.hidden = true; picker.disabled = false;
        setZone(saved);
      } catch (error) {settingsNotice(error.message, true);}
      finally {busy = false;}
    }
    picker.addEventListener("change", () => {save.disabled = busy || picker.value === saved;});
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy || save.disabled) return;
      busy = true; picker.disabled = save.disabled = true;
      try {
        const result = await request("/organization", {version, timezone: picker.value});
        version = result.version; saved = result.timezone; setZone(saved);
        settingsNotice("Time zone saved. All team members use this time zone. Changing it recalculates overtime and penalties for recorded shifts.");
        // Organization persistence is confirmed independently of refreshing the
        // Scheduler view. A later refresh failure must not turn it into a failed save.
        if (state.data?.user) {
          try { await refresh(); } catch (error) { notice(error.message, true); }
        }
      } catch (error) {
        settingsNotice(error.message, true);
        if (error.status === 409) {busy = false; await loadSettings(); settingsNotice("Settings changed. Review the current time zone and try again.", true);}
      } finally {busy = false; picker.disabled = false; save.disabled = picker.value === saved;}
    });
    const view = form.closest(".view");
    new MutationObserver(() => { if (!view.hidden) void loadSettings(); }).observe(view, {attributes:true,attributeFilter:["hidden"]});
    if (!view.hidden) void loadSettings();
  }
  initializeOrganizationSettings();
  async function restoreClock() {
    state.root ||= document.getElementById("scheduler-root"); if(!state.root)return;
    const view = state.root.closest('[id^="view-"]');
    if (view) new MutationObserver(updateLocationStatus).observe(view,{attributes:true,attributeFilter:["hidden"]});
    beginPolling();
    const generation = state.authGeneration;
    try {const bootstrap = await request("/bootstrap"); if(generation === state.authGeneration) {setZone(bootstrap.timezone); if(bootstrap.user) await refresh();}}
    catch (_) { /* Authentication and connection failures are shown on opening Scheduler. */ }
  }
  document.addEventListener("visibilitychange",() => {if(!document.hidden && state.data?.user) {if(state.locationEnabled)void captureLocation(true); void refresh();void loadOrders();}});
  accountChannel?.addEventListener("message",() => {resetAccount(); auth(false); void refresh();});
  window.addEventListener("online",() => {if(state.locationEnabled) void captureLocation(true);});
  window.addEventListener("pagehide",stopLocation);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",restoreClock,{once:true}); else void restoreClock();
  window.CeasefireScheduler = {activate,init(options = {}) {state.root = options.root || document.getElementById("scheduler-root");},hasPendingOperation() {return state.busy || !!state.dialog || state.settingsDirty;}};
})();
