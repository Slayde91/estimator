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
  function attach(form, {kind,record,request,readOnly,version,setVersion,staff,locked,isOpen}) {
    const box=el('details'),heading=el('summary',term('Activity history')),info=el('dl'),list=el('ol');
    box.className='crm-timeline';info.className='kanban-card-details';list.className='crm-event-list';
    const watched={...record};
    function dates(){
      info.replaceChildren();
      for(const [key,name] of [['created_at','Created at'],['updated_at','Updated at'],['last_interaction_at','Last interaction']])
        info.append(el('dt',term(name)),el('dd',stamp(watched[key])));
    }
    dates();const message=el('p');message.className='helper';message.setAttribute('role','status');
    let cursor=null,seen=false,busy=false,serial=0,replay=null;
    const earlier=button('Load earlier activity',()=>load(cursor));earlier.hidden=true;
    box.append(heading,info,list,earlier,message);form.append(box);
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
    staff.then(rows=>populate(owner,rows)).catch(()=>{});
    const controls=el('fieldset');controls.className='contacts-group';
    controls.append(el('legend',term('Log activity')),label('Activity type',type),label('Activity owner',owner),noteField,timeField,dueField);
    const log=button('Log activity',()=>submit({kind,id:record.id,type:type.value,text:note.value,...(owner.disabled ? {} : {owner_id:owner.value}),due_date:due.value,
      ...(occurred.value ? {occurred_at:new Date(occurred.value).toISOString()} : {})}));
    log.classList.add('crm-activity-submit');controls.append(log);if(!readOnly)box.append(controls);
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
      if(detail.text)li.append(el('p',detail.text));
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
        li.append(button('Complete task',()=>submit({kind:item.kind,id:item.record_id,type:'Task completed',task_id:item.id})));
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
        cursor=result.next_before;earlier.hidden=!cursor;seen=true;
        message.textContent=list.children.length?'':term('No activity recorded.');
        if(result.metadata){Object.assign(watched,result.metadata);dates();}
      } catch(error) {if(seq===serial&&isOpen())message.textContent=error.message;}
    }
    async function submit(values) {
      if(busy || locked())return;
      if(values.type!=='Task completed'&&!values.text.trim()){note.focus();message.textContent=term('Enter activity details.');return;}
      const fingerprint=JSON.stringify(values);
      if(!replay||replay.fingerprint!==fingerprint)replay={fingerprint,id:crypto.randomUUID()};
      busy=true;controls.disabled=true;
      try {
        const result=await request('activity',{...values,version:version(),request_id:replay.id});
        if(!isOpen())return;
        // Only advance an editor to its own consecutive revision. A replay
        // after another user's change cannot grant a stale form a fresh version.
        if(result.version===version()+1)setVersion(result.version);
        replay=null;
        if(values.type!=='Task completed'){note.value='';due.value='';owner.value=window.ClassifireAccess?.user?.id || '';occurred.value='';}
        await load();
      } catch(error) {if(isOpen())message.textContent=error.message;}
      finally {busy=false;controls.disabled=false;}
    }
    box.addEventListener('toggle',()=>{if(box.open&&!seen)void load();});
    return {pending:()=>busy,dirty:()=>Boolean(note.value || due.value || occurred.value),fingerprint:()=>[type.value,note.value,due.value,owner.value,occurred.value]};
  }
  function historyPanel(read, isCurrent, onListChanged) {
    const panel = el('details'), heading = el('summary', term('Activity history'));
    panel.className = 'card commercial-side-panel record-activity-history';
    window.CeasefireI18n?.text(heading, 'Activity history');
    const list = el('ol'), message = el('p');
    list.className = 'crm-event-list'; message.className = 'helper'; message.setAttribute('role','status');
    const earlier = button('Load earlier activity', showMore);
    earlier.hidden = true;
    panel.append(heading, list, earlier, message);
    let serial = 0, events = [], shown = 0;
    const kinds = {quote:'Quote', work_order:'Work Order', purchase_order:'Purchase Order'};
    function showMore() {
      const next = Math.min(shown + 25, events.length);
      for (const event of events.slice(shown, next)) {
        const row = el('li'), time = el('time', stamp(event.at)), meta = el('p');
        time.dateTime = event.at; meta.className = 'helper'; meta.append(time);
        if (event.actor) meta.append(' · ', event.actor);
        row.append(el('strong', term(event.label)), meta);
        const subject = [kinds[event.kind] && term(kinds[event.kind]), event.subject].filter(Boolean);
        if (subject.length) row.append(el('p', subject.join(' · ')));
        if (event.previous_status) row.append(el('p', term(event.previous_status) + ' → ' + term(event.status)));
        list.append(row);
      }
      shown = next; earlier.hidden = shown >= events.length;
      onListChanged?.(list);
    }
    async function refresh() {
      const ticket = ++serial;
      if (!panel.open || !panel.isConnected || !isCurrent()) return;
      const current = () => ticket === serial && panel.open && panel.isConnected && isCurrent();
      list.replaceChildren(); earlier.hidden = true; message.textContent = term('Loading…');
      onListChanged?.(list);
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
    return {element:panel, refresh};
  }
  window.ClassifireCrmActivity={attach,ownerSelect,populate,historyPanel};
})();
