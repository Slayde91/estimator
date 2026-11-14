(() => {
  'use strict';
  const term = value => window.CeasefireI18n?.translate(value) || value;
  const stamp = value => value ? new Date(value).toLocaleString(document.documentElement.lang || undefined) : term('Unknown');
  function el(tag, text) {const item=document.createElement(tag); if(text!=null)item.textContent=text; return item;}
  function label(text, control) {
    const field=el('label');field.className='field';
    field.append(el('span',term(text)),control);control.setAttribute('aria-label',term(text));return field;
  }
  function button(name, fn) {
    const b=el('button',term(name));b.type='button';b.className='button secondary';b.addEventListener('click',fn);return b;
  }
  function ownerSelect(record) {
    const control=el('select');
    const creator = record?.id ? null : window.ClassifireAccess?.user;
    const ownerId = creator?.id || record?.owner_id || '';
    if (!creator) control.add(new Option(term('Unassigned'),''));
    if (ownerId) control.add(new Option(creator?.name || record?.owner_name || ownerId, ownerId));
    control.value=ownerId;return control;
  }
  function populate(control, staff) {
    const keep=control.value;
    for(const row of staff) {
      if (![...control.options].some(o=>o.value===row.id))control.add(new Option(row.name,row.id));
    }
    control.value=keep;
  }
  let headingNumber = 0;
  function activityForm({write, refresh, locked, current, message, staff}) {
    let busy=false, replay=null, staffLoaded=false;
    const type=el('select'),note=el('textarea'),due=el('input'),owner=ownerSelect(),occurred=el('input');
    for(const name of ['Call','Email','Meeting','Note','Task'])type.add(new Option(term(name),name));
    type.value='Note';due.type='date';occurred.type='datetime-local';note.maxLength=4000;note.rows=5;
    const noteField=label('Activity details',note);noteField.classList.add('crm-activity-details');
    const actor=window.ClassifireAccess?.user;
    function setOwnerMode() {
      owner.disabled=Boolean(actor && type.value!=='Task');
      if(owner.disabled)owner.value=actor.id;
    }
    setOwnerMode();
    const dueField=label('Due date',due);dueField.hidden=true;
    const timeField=label('Interaction time',occurred);timeField.hidden=true;
    type.addEventListener('change',()=>{
      setOwnerMode();
      dueField.hidden=type.value!=='Task';if(dueField.hidden)due.value='';
      timeField.hidden=!['Call','Email','Meeting'].includes(type.value);if(timeField.hidden)occurred.value='';
    });

    const controls=el('fieldset');controls.className='contacts-group';
    controls.append(el('legend',term('Log activity')),label('Activity type',type),label('Activity owner',owner),noteField,timeField,dueField);
    const log=button('Log activity',()=>submit({type:type.value,text:note.value,...(owner.disabled ? {} : {owner_id:owner.value}),due_date:due.value,
      ...(occurred.value ? {occurred_at:new Date(occurred.value).toISOString()} : {})}));
    log.classList.add('crm-activity-submit');controls.append(log);
    function update() {
      setOwnerMode();
      controls.disabled = busy || locked();
      if (!staffLoaded && !controls.disabled) {
        staffLoaded=true;
        Promise.resolve().then(staff).then(rows=>populate(owner,rows)).catch(()=>{staffLoaded=false;});
      }
    }
    async function submit(values) {
      if(busy || locked() || !current())return;
      if(values.type!=='Task completed'&&!values.text.trim()){note.focus();message.textContent=term('Enter activity details.');return;}
      const fingerprint=JSON.stringify(values);
      if(!replay||replay.fingerprint!==fingerprint)replay={fingerprint,id:crypto.randomUUID()};
      busy=true;controls.disabled=true;
      try {
        await write({...values,request_id:replay.id});
        if(!current())return;
        replay=null;
        if(values.type!=='Task completed'){note.value='';due.value='';owner.value=window.ClassifireAccess?.user?.id || '';occurred.value='';}
        await refresh();
      } catch(error) {if(current())message.textContent=error.message;}
      finally {busy=false;update();}
    }
    return {controls, submit, update, pending:()=>busy, dirty:()=>Boolean(note.value || due.value || occurred.value),
      fingerprint:()=>[type.value,note.value,due.value,owner.value,occurred.value]};
  }
  async function readStaff() {
    const response = await fetch('/api/contacts/staff',{cache:'no-store'});
    if (!response.ok) throw new Error('The directory could not be updated.');
    return (await response.json()).staff;
  }
  function attach(form, {kind,record,request,readOnly,version,setVersion,staff,locked,isOpen}) {
    const box=el('details'),heading=el('summary',term('Activity history')),info=el('dl'),list=el('ol');
    box.className='crm-timeline';info.className='kanban-card-details';list.className='crm-event-list record-history-scroll';
    heading.id='crm-activity-heading-'+(++headingNumber);
    const watched={...record};
    function dates(){
      info.replaceChildren();
      for(const [key,name] of [['created_at','Created at'],['updated_at','Updated at'],['last_interaction_at','Last interaction']])
        info.append(el('dt',term(name)),el('dd',stamp(watched[key])));
    }
    dates();const message=el('p');message.className='helper';message.setAttribute('role','status');
    let cursor=null,seen=false,serial=0;
    const earlier=button('Load earlier activity',()=>load(cursor));earlier.hidden=true;
    box.append(heading,info,list,earlier,message);form.append(box);
    const editor=activityForm({locked, current:isOpen, message, staff:()=>staff, refresh:()=>load(), async write(values) {
      const result=await request('activity',{kind,id:record.id,...values,version:version()});
      if(isOpen() && result.version===version()+1)setVersion(result.version);
    }});
    if(!readOnly)box.append(editor.controls);
    function row(item){
      const li=el('li'),head=el('strong',term(item.event_type)),meta=el('p');
      const named=[stamp(item.recorded_at),term('Logged by')+': '+(item.actor_name || term('Unknown'))];
      if(item.owner_name)named.push(term('Owner')+': '+item.owner_name);
      if(item.due_date)named.push(term('Due date')+': '+item.due_date);
      if(item.occurred_at)named.push(term('Interaction time')+': '+stamp(item.occurred_at));
      if(item.completed_at)named.push(term('Task completed')+': '+stamp(item.completed_at));
      meta.className='helper';meta.textContent=named.join(' · ');li.append(head,meta);
      const detail=item.detail;
      if(detail.subject)li.append(el('p',detail.subject));
      if(item.event_type==='Follow-up corrected' && detail.previous && detail.current) {
        const summary=action=>[action.next_action,action.follow_up_date,term(action.status || 'Pending')].filter(Boolean).join(' · ');
        li.append(el('p',summary(detail.previous)+' → '+summary(detail.current)));
      } else if(detail.text)li.append(el('p',detail.text));
      if(item.event_type==='Updated' && detail.fields?.length) {
        const names={name:'Name',email:'Email',phone:'Phone',title:'Title',company:'Company',account_id:'Company',contact_id:'Contact',
          abn_acn:'ABN/ACN',billing_address:'Billing address',site_address:'Site address',person_snapshot:'Contact details',
          description:'Description',status:'Status',region:'Region',owner:'Owner',owner_id:'Owner',owner_name:'Owner',links:'Linked records',follow_up:'Follow-up'};
        li.append(el('p',[...new Set(detail.fields.map(key=>term(names[key]||key)))].join(', ')));
      }
      if(detail.previous_status)li.append(el('p',term(detail.previous_status)+' → '+term(detail.status)));
      if(detail.project_no)li.append(el('p',[detail.project_no,term(detail.status)].filter(Boolean).join(' · ')));
      if(Object.hasOwn(detail,'owner'))li.append(el('p',term('Owner')+': '+[detail.previous_owner,detail.owner || term('Unassigned')].filter(Boolean).join(' → ')));
      if(Object.hasOwn(detail,'region') && detail.region)li.append(el('p',term('Region')+': '+detail.region));
      if(!readOnly && item.event_type==='Task' && !item.completed_at)
        li.append(button('Complete task',()=>editor.submit({kind:item.kind,id:item.record_id,type:'Task completed',task_id:item.id})));
      return li;
    }
    async function load(before=null) {
      const seq=++serial;
      try {
        const query=new URLSearchParams({kind,id:record.id});
        if(before)query.set('before',before);
        const result=await request('activity?'+query);if(seq!==serial || !isOpen())return;
        if(!before)list.replaceChildren();
        for(const item of result.events)list.append(row(item));
        if(box.open)sizeList(list,5,heading);
        cursor=result.next_before;earlier.hidden=!cursor;seen=true;
        message.textContent=list.children.length?'':term('No activity recorded.');
        if(result.metadata){Object.assign(watched,result.metadata);dates();}
      } catch(error) {if(seq===serial&&isOpen())message.textContent=error.message;}
    }
    box.addEventListener('toggle',()=>{
      if(!box.open){stopSizing(list);return;}
      if(!readOnly)editor.update();
      if(!seen)void load(); else sizeList(list,5,heading);
    });
    return {...editor,refresh:()=>load()};
  }
  const listObservers = new WeakMap();
  function stopSizing(list) {
    listObservers.get(list)?.disconnect();
    listObservers.delete(list);
  }
  function sizeList(list, count, heading) {
    stopSizing(list);
    if (list.childElementCount <= count) {
      list.style.removeProperty('max-height');
      list.removeAttribute('tabindex');
      return;
    }
    const rows = Array.from(list.children).slice(0, count);
    list.tabIndex = 0;
    list.setAttribute('aria-labelledby', heading.id);
    const measure = () => {
      const first = rows[0].getBoundingClientRect(), last = rows.at(-1).getBoundingClientRect();
      if (first.height) list.style.maxHeight = `${last.bottom - first.top}px`;
    };
    const observer = new ResizeObserver(measure);
    rows.forEach(row => observer.observe(row));
    listObservers.set(list, observer);
    measure();
  }
  function historyPanel(read, isCurrent, headingId, options={}) {
    const panel = el('details'), heading = el('summary', term('Activity history'));
    panel.className = 'card commercial-side-panel record-activity-history';
    window.CeasefireI18n?.text(heading, 'Activity history');
    const list = el('ol'), message = el('p');
    list.className = 'crm-event-list'; message.className = 'helper'; message.setAttribute('role','status');
    heading.id = headingId || 'record-activity-heading-'+(++headingNumber); list.classList.add('record-history-scroll');
    const earlier = button('Load earlier activity', showMore);
    earlier.hidden = true;
    panel.append(heading, list, earlier, message);
    const editor = activityForm({write:options.write, refresh, message, staff:readStaff,
      current:()=>panel.isConnected && isCurrent(), locked:()=>!options.write || !options.canWrite()});
    if(options.write && (!window.ClassifireAccess || window.ClassifireAccess.can('edit')))panel.append(editor.controls);
    let serial = 0, events = [], shown = 0;
    const kinds = {quote:'Quote', work_order:'Work Order', purchase_order:'Purchase Order'};
    function showMore() {
      const next = Math.min(shown + 25, events.length);
      for (const event of events.slice(shown, next)) {
        const row = el('li'), time = el('time', stamp(event.at)), meta = el('p');
        time.dateTime = event.at; meta.className = 'helper'; meta.append(time);
        if (event.actor) meta.append(' · ', event.actor);
        for (const [title,value] of [['Owner',event.owner_name],['Due date',event.due_date],
          ['Interaction time',event.occurred_at && stamp(event.occurred_at)],['Task completed',event.completed_at && stamp(event.completed_at)]]) {
          if (value) meta.append(' \u00b7 ',term(title)+': '+value);
        }
        row.append(el('strong', term(event.label)), meta);
        const subject = [kinds[event.kind] && term(kinds[event.kind]), event.subject].filter(Boolean);
        if (subject.length) row.append(el('p', subject.join(' · ')));
        if (event.previous_status) row.append(el('p', term(event.previous_status) + ' → ' + term(event.status)));
        if(event.label==='Task' && !event.completed_at && options.canWrite?.())
          row.append(button('Complete task',()=>editor.submit({type:'Task completed',task_id:event.id})));
        list.append(row);
      }
      shown = next; earlier.hidden = shown >= events.length;
      sizeList(list, 5, heading);
    }
    async function refresh() {
      const ticket = ++serial;
      if (!panel.open || !panel.isConnected || !isCurrent()) {stopSizing(list);return;}
      editor.update();
      const current = () => ticket === serial && panel.open && panel.isConnected && isCurrent();
      list.replaceChildren(); earlier.hidden = true; message.textContent = term('Loading…');
      sizeList(list, 5, heading);
      try {
        const data = await read();
        if (!current()) return;
        events = data.events.slice().sort((a,b) => Date.parse(b.at) - Date.parse(a.at));
        shown = 0; showMore();
        message.textContent = events.length ? '' : term('No activity recorded.');
      } catch (error) {
        if (current()) message.textContent = term(error.message);
      }
    }
    panel.addEventListener('toggle', refresh);
    return {element:panel, refresh, update:()=>{if(panel.open)editor.update();}, dirty:editor.dirty, pending:editor.pending, fingerprint:editor.fingerprint, dispose:()=>stopSizing(list)};
  }
  window.ClassifireCrmActivity={attach,ownerSelect,populate,historyPanel,sizeList,stopSizing};
})();
