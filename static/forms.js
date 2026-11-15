/* Staff templates and records use their own versioned store, independent of the loaded project. */
(() => {
  'use strict';
  const root = document.getElementById('forms-root');
  if (!root) return;
  const roles = ['viewer', 'editor', 'admin'];
  const pdfThemes = [['ceasefire','CLASSIFIRE'],['midnight','Midnight'],['ocean','Ocean'],['forest','Forest'],['slate','Slate']];
  let generation = 0, pending = false, editor = null, fields = null, dirty = false, changeCount = 0;
  let staff = [], records = [], templates = [], panel = 'templates', query = '';
  const el = (tag, value, cls) => {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = value;
    if (cls) node.className = cls;
    return node;
  };
  function button(label, run, primary = false) {
    const node = el('button', label, 'button ' + (primary ? 'primary' : 'secondary'));
    if (window.CeasefireMessages?.[label]) window.CeasefireI18n.text(node,label);
    node.type = 'button';
    node.addEventListener('click', () => { Promise.resolve().then(run).catch(report); });
    return node;
  }
  function report(error) {
    const area = root.querySelector('.forms-feedback');
    if (area) { area.textContent = error.message; area.hidden = false; area.focus(); }
    else window.CeasefireDialogs?.message(error.message, true);
  }
  async function api(route, body) {
    const response = await fetch('/api/forms/' + route, {cache:'no-store', headers:{'Content-Type':'application/json'},
      ...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body)})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The forms request could not be completed.');
    return data;
  }
  function busy() { return pending || Boolean(editor?.isBusy() || fields?.isBusy()); }
  function changed() { return dirty || Boolean(editor?.isDirty()); }
  function frame() {
    editor = null; fields = null; dirty = false; ++changeCount;
    const feedback = el('p', '', 'forms-feedback message error');
    feedback.hidden = true; feedback.tabIndex = -1; feedback.setAttribute('role','alert');
    const content = el('div', null, 'forms-content');
    root.replaceChildren(feedback, content);
    return content;
  }
  async function mayDiscard() {
    if (busy()) return false;
    return !changed() || await window.CeasefireDialogs.confirm('Leave Forms?', 'Discard the unsaved changes to this form?', 'Discard changes', 'Keep editing');
  }
  async function leave() {
    if (!await mayDiscard() || busy()) return false;
    ++generation; frame(); root.replaceChildren();
    staff = []; records = []; templates = [];
    return true;
  }
  function date(value) {
    return value ? window.ClassifireDates.dateTime(value) : '—';
  }
  function heading(title, actions = []) {
    const bar = el('div', null, 'forms-heading');
    bar.append(el('h2', title));
    const buttons = el('div', null, 'actions');
    buttons.append(...actions); bar.append(buttons);
    return bar;
  }
  function table(headers, rows, emptyText) {
    const scroll = el('div', null, 'table-scroll'), grid = el('table');
    const head = grid.createTHead().insertRow();
    headers.forEach(text => { const th = el('th', text); th.scope = 'col'; head.append(th); });
    const body = grid.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const value of row) {
        const td = tr.insertCell();
        if (value instanceof Node) td.append(value); else td.textContent = value ?? '—';
      }
    }
    if (!rows.length) {const cell = body.insertRow().insertCell(); cell.colSpan = headers.length; cell.textContent = emptyText;}
    scroll.append(grid); return scroll;
  }
  function link(label, run) {const control = el('button',label,'text-button'); control.type='button'; control.addEventListener('click',()=>Promise.resolve().then(run).catch(report)); return control;}
  function badge(value) {
    const badge = el('span', value, 'forms-badge forms-status-' + value);
    if (value === 'requested') window.CeasefireI18n.text(badge,'Requested');
    return badge;
  }
  function uid() { return crypto.randomUUID(); }
  function blank(mode = 'timeline') {
    return {id:uid(),version:0,name:'',description:'',mode,status:'draft',roles:['admin','editor'],fields:[],
      settings:{orientation:'portrait',...(mode === 'workflow' ? {stages:[{id:uid(),name:'Preparation',roles:['admin','editor']},{id:uid(),name:'Approval',roles:['admin']}]} : {})}};
  }
  function modal(title, closeIcon = false) {
    const dialog = el('dialog', null, 'forms-dialog'); dialog.setAttribute('aria-label', title);
    const close = closeIcon ? window.ClassifireFormControls.iconButton('Close','close',()=>dialog.close()) : button('Close',()=>dialog.close());
    dialog.append(heading(title,[close])); document.body.append(dialog);
    const opener = document.activeElement;
    dialog.addEventListener('close', () => {dialog.remove(); if (opener?.isConnected) opener.focus();}, {once:true});
    return dialog;
  }
  function newTemplate() {
    const dialog = modal('Create template');
    const options = el('div', null, 'forms-start-options');
    const choices = [
      ['Timeline','Fill out a form and submit it as a single record.', 'timeline'],
      ['Workflow','Collect information and approvals in stages.', 'workflow']
    ];
    for (const [name,detail,kind] of choices) {
      const choose = button(name, () => {
        dialog.close(); edit(blank(kind));
      });
      choose.classList.add('forms-start-option'); choose.append(el('small',detail)); options.append(choose);
    }
    dialog.append(options); dialog.showModal();
  }
  function outlineDialog() {
    const dialog=modal('Add fields from an outline');
    const form=el('form',null,'forms-outline');
    const label=el('label',null,'field'), outline=el('textarea');
    outline.rows=8;outline.maxLength=12000;outline.required=true;
    outline.placeholder='Site address\nInspection date\nTable: Activities | Task, Hours\nPhotos\nSignature';
    label.append(el('span','Field outline'),outline);
    const status=el('p','','helper');status.setAttribute('role','status');
    const create=el('button','Add fields','button primary');create.type='submit';
    const actions=el('div',null,'actions');actions.append(create);
    form.append(label,el('p','Enter one field per line. For a table, separate the title and column names with a vertical bar.','helper'),status,actions);
    dialog.append(form);dialog.showModal();
    let result=[];
    const controller = new AbortController();
    if(window.LanguageModel) {
      const language={expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]};
      Promise.resolve().then(()=>window.LanguageModel.availability(language)).then(state=>{
        if(state!=='available' || !dialog.open) return;
        const suggest = button('Suggest fields with local AI',async()=>{
          const prompt=outline.value.trim();
          if(!prompt){outline.reportValidity();return;}
          suggest.disabled=true;create.disabled=true;outline.readOnly=true;
          status.textContent='Generating field suggestions on this device…';
          let session;
          try {
            session=await window.LanguageModel.create({...language,signal:controller.signal});
            const types=['text','textarea','number','date','date_range','datetime','table','yes_no','choice','photo','person','signature','attachment','location'];
            const response=await session.prompt('Suggest editable form fields for this request. Return each label prefixed by its field type and a colon, one string per field. For tables or choice fields put column or choice names after a vertical bar. Supported types: '+types.join(', ')+'. Request: '+prompt,
              {responseConstraint:{type:'array',items:{type:'string'},minItems:1,maxItems:100},signal:controller.signal});
            const lines=JSON.parse(response);
            if(!Array.isArray(lines)||!lines.length||lines.length>100||lines.some(x=>typeof x!=='string'||x.length>500)) throw Error('Could not read field suggestions.');
            if(dialog.open){outline.value=lines.join('\n');status.textContent='Review and edit the suggested fields before adding them.';}
          } catch(error){if(dialog.open)status.textContent=error.message;}
          finally {session?.destroy();suggest.disabled=false;create.disabled=false;outline.readOnly=false;}
        });
        actions.prepend(suggest);
      }).catch(()=>{});
    }
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const lines=outline.value.split(/\r?\n/).map(s=>s.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
      if(!lines.length || lines.length>500) {outline.setCustomValidity('Enter between 1 and 500 fields.');outline.reportValidity();return;}
      result=lines.map(outlineField);dialog.close();
    });
    outline.addEventListener('input',()=>outline.setCustomValidity(''));
    return new Promise(resolve=>dialog.addEventListener('close',()=>{controller.abort();resolve(result);},{once:true}));
  }
  function outlineField(line) {
    const [description,detail=''] = line.split('|',2);
    const types = [
      ['table',/\btable\b/i], ['group',/\brepeating group\b/i], ['choice',/\b(dropdown|choice)\b/i],
      ['date_range',/\bdate range\b/i],['datetime',/\bdate and time\b/i],['date',/\bdate\b/i],
      ['number',/\b(number|hours|quantity|count)\b/i],['photo',/\bphotos?\b/i],['signature',/\bsignature\b/i],
      ['attachment',/\battachments?\b/i],['person',/\b(team member|person)\b/i],['location',/\blocation\b/i],
      ['textarea',/\b(notes|comments|observations|description)\b/i],['yes_no',/\byes\s*\/\s*no\b/i]
    ];
    const explicit=description.includes(':') ? description.split(':',1)[0].trim().toLowerCase() : '';
    const allowed=['text','textarea','number','date','date_range','datetime','table','group','yes_no','choice','photo','person','signature','attachment','location'];
    const type = allowed.includes(explicit) ? explicit : types.find(([,pattern])=>pattern.test(description))?.[0] || 'text';
    const label = (description.split(':').slice(1).join(':').trim() || description.trim()).slice(0,250);
    const field = {id:uid(),type,label};
    const items = detail.split(',').map(name=>name.trim().slice(0,250)).filter(Boolean);
    if (type === 'choice') field.options = items.length ? [...new Set(items)] : ['Yes','No'];
    if (type === 'group' || type === 'table')
      field[type === 'table' ? 'columns':'children'] = (items.length ? items : ['Description']).map(name=>({
        id:uid(),type:/\b(hours|quantity|count|number)\b/i.test(name)?'number':'text',label:name
      }));
    return field;
  }
  async function refresh() {
    const stamp = ++generation;
    const content = frame(); content.append(el('p','Loading forms…','helper'));
    try {
      await window.ClassifireAccess.ready;
      const [library, register, people] = await Promise.all([api('templates'),api('entries'),api('staff')]);
      if (stamp !== generation) return false;
      templates = library.templates; records = register.entries; staff = people.staff;
      libraryView();return true;
    } catch(error) {if(stamp === generation) {content.replaceChildren(button('Retry',refresh)); report(error);}return false;}
  }
  function libraryView() {
    const host = frame(), box = el('section', null, 'card forms-register');
    const tabs = el('div',null,'actions forms-tabs');
    for (const [key,text] of [['templates','Templates'],['records','Form records']]) {
      const tab = button(text, () => {panel = key; query = ''; libraryView();}, true);
      tab.setAttribute('aria-pressed', String(panel === key)); tabs.append(tab);
    }
    const actions = [];
    if (window.ClassifireAccess.can('edit')) {
      const file=el('input');file.type='file';file.accept='.json,application/json';file.hidden=true;
      file.addEventListener('change',async()=>{
        const selected=file.files[0];if(!selected)return;
        try {
          if(selected.size>2*1024*1024) throw Error('Choose a template JSON file smaller than 2 MiB.');
          const source=JSON.parse(await selected.text());
          if(!source || typeof source.name!=='string' || !Array.isArray(source.fields) || source.fields.length>500 || !source.fields.every(f=>f && typeof f.id==='string' && typeof f.type==='string' && typeof f.label==='string'))
            throw Error('Choose a CLASSIFIRE form template JSON file.');
          const model={...blank(source.mode),name:source.name,description:source.description || '',fields:source.fields,settings:source.settings || {}};
          if(Array.isArray(source.roles)) model.roles=source.roles.filter(r=>roles.includes(r));
          edit(model);
        } catch(error){report(error);} finally{file.value='';}
      });
      actions.push(file,button('Import template',()=>file.click()),button('Create template',newTemplate,true));
    }
    box.append(heading(panel === 'templates' ? 'Form templates' : 'Form records',actions));
    const approvals=records.filter(row=>row.can_approve && row.status !== 'requested');
    if(approvals.length) {
      const queue=el('details',null,'forms-expiries');queue.open=true;
      queue.append(el('summary','Awaiting your approval ('+approvals.length+')'));
      queue.append(table(['Form','Created by','Updated'],approvals.map(row=>[
        link(row.name,()=>openRecord(row.id)),row.created_by_name,date(row.updated_at)
      ]),''));
      box.append(queue);
    }
    const reminders = upcomingExpiries();
    if(reminders.length) {
      const due = el('details',null,'forms-expiries'); due.open=true;
      due.append(el('summary','Expiry reminders ('+reminders.length+')'));
      due.append(table(['Form','Field','Expiry date'],reminders.map(({entry,reminder})=>[
        link(entry.name,()=>openRecord(entry.id)),reminder.label,window.ClassifireDates.date(reminder.date)
      ]),''));
      box.append(due);
    }
    const label = el('label',null,'field forms-search'), search = el('input'); search.type='search'; search.value=query;
    label.append(el('span',panel === 'templates' ? 'Search templates' : 'Search form records'),search);
    const body = el('div'); box.append(label,body); host.append(tabs,box);
    function filter() {
      query = search.value; const needle = query.trim().toLocaleLowerCase();
      if(panel === 'records') {
        const matches = records.filter(row => [row.name,row.template_name,row.created_by_name,row.status].join(' ').toLocaleLowerCase().includes(needle));
        body.replaceChildren(table(['Template','Created by','Status','Updated'],matches.map(row=>[
          link(row.template_name || row.name || 'Form',()=>openRecord(row.id)),row.created_by_name,badge(row.status),date(row.updated_at)
        ]), needle ? 'No matching form records.' : 'No form records yet.'));
      } else {
        const matches = templates.filter(t=>[t.name,t.description,t.status,t.mode].join(' ').toLocaleLowerCase().includes(needle));
        body.replaceChildren(table(['Template','Type','Version','Status','Actions'],matches.map(t=>{
          const actions = el('div',null,'actions forms-row-actions');
          if (t.can_fill) actions.append(button('Fill out',()=>openTemplate(t.id,'fill'),true));
          if (t.can_manage) actions.append(button('Edit',()=>openTemplate(t.id,'edit')));
          if (t.can_assign) actions.append(button('Assign',()=>assignTemplate(t)));
          return [link(t.name,()=>openTemplate(t.id,'detail')),t.mode === 'workflow' ? 'Workflow' : 'Timeline',t.version,badge(t.status),actions];
        }), needle ? 'No matching templates.' : 'No templates are available for your staff role.'));
      }
    }
    search.addEventListener('input',filter); filter();
  }
  async function assignTemplate(template) {
    const dialog = modal('Assign');
    const label = el('label',null,'field'), caption = el('span'), select = el('select');
    window.CeasefireI18n.text(dialog.querySelector('h2'),'Assign');
    window.CeasefireI18n.text(caption,'Team member');
    const placeholder = new Option('', '');
    window.CeasefireI18n.text(placeholder,'Choose…');
    select.append(placeholder);
    label.append(caption, select);
    const feedback = el('p',null,'helper');
    feedback.setAttribute('role','status');
    const submit = button('Assign',save,true), close = dialog.querySelector('button');
    let requestId = uid(), sending = false;
    submit.disabled = true;
    select.addEventListener('change',() => { requestId = uid(); submit.disabled = !select.value; });
    dialog.addEventListener('cancel',event => { if (sending) event.preventDefault(); });
    dialog.append(el('p',template.name),label,feedback,submit);
    dialog.showModal();
    try {
      const {staff} = await api('template/assignees?'+new URLSearchParams({id:template.id,version:template.version}));
      if (!dialog.open) return;
      select.append(...staff.map(member=>new Option(member.name,member.id)));
      select.disabled = !staff.length;
      if (!staff.length) window.CeasefireI18n.text(feedback,'No eligible team members.');
      else select.focus();
    } catch(error) { feedback.textContent = error.message; }
    async function save() {
      if (sending || !select.value) return;
      sending = true;
      select.disabled = submit.disabled = close.disabled = true;
      try {
        const assigned = await api('entry/assign',{id:requestId,template_id:template.id,
          template_version:template.version,member_id:select.value});
        dialog.close();
        if (await refresh()) {
          const message = el('p',null,'helper');
          message.setAttribute('role','status');
          root.querySelector('.forms-register').prepend(message);
          window.CeasefireI18n.text(message,'Assigned to {0}.',[assigned.assigned_to_name]);
        }
      } catch(error) { feedback.textContent = error.message; }
      finally {sending = false; select.disabled = submit.disabled = close.disabled = false;}
    }
  }
  async function openTemplate(id, view) {
    const stamp = ++generation, template = await api('template?id='+encodeURIComponent(id));
    if (stamp !== generation) return;
    if (view === 'edit') return edit(template);
    if (view === 'fill') return entryView(template);
    templateDetail(template);
  }
  async function openRecord(id) {
    const stamp = ++generation, entry = await api('entry?id='+encodeURIComponent(id));
    if (stamp === generation) entryView(entry.template, entry);
  }
  function upcomingExpiries() {
    const day = new Date(), today=Date.UTC(day.getFullYear(),day.getMonth(),day.getDate());
    const due=[];
    for(const entry of records) for(const reminder of entry.reminders || []) {
      const expires=Date.parse(reminder.date+'T00:00:00Z');
      if(Number.isFinite(expires) && expires<=today+reminder.days_before*86400000) due.push({entry,reminder});
    }
    return due.sort((a,b)=>a.reminder.date.localeCompare(b.reminder.date));
  }
  function describe(value,type) {
    if (value === undefined || value === null || value === '') return '—';
    if (type === 'date' || type === 'expiry_date') return window.ClassifireDates.date(value);
    if (type === 'datetime') return window.ClassifireDates.wallTime(value);
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(item=>typeof item === 'object' ? item.name || item.label || 'Item' : item).join(', ');
    return value.member_name || value.description || value.answer || [value.start,value.end].filter(Boolean).join(' – ') || 'Recorded';
  }
  function templateDetail(t) {
    const host = frame(), box = el('section',null,'card forms-register');
    const actions = [button('Back to templates',()=>{panel='templates';return refresh();}),button('Preview',()=>preview(t))];
    if (t.can_fill) actions.push(button('Fill out',()=>entryView(t),true));
    if (t.can_manage) {
      actions.push(button('Edit template',()=>edit(t)),button('Duplicate',()=>edit({...structuredClone(t),id:uid(),version:0,status:'draft',name:t.name+' (copy)'})),button('Version history',()=>history(t)));
      actions.push(button('Export template',()=>{
        const {name,description,fields,settings,mode,roles} = t;
        const data=new Blob([JSON.stringify({name,description,fields,settings,mode,roles},null,2)],{type:'application/json'});
        const url=URL.createObjectURL(data),a=el('a');a.href=url;
        a.download=(name.replace(/[^A-Za-z0-9_. -]/g,'_').slice(0,100)||'form')+'.json';
        document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      }));
      if(t.status!=='archived') actions.push(button('Archive',async()=>{
        if(!await window.CeasefireDialogs.confirm('Archive template?', 'Stop new forms using this template and keep its saved records.', 'Archive', 'Cancel')) return;
        const {id,version,name,description,mode,roles,settings,fields} = t;
        const saved=await api('template/save',{id,version,name,description,mode,roles,settings,fields,status:'archived'});
        templateDetail(saved);
      }));
    }
    box.append(heading(t.name,actions),el('p',(t.settings?.display_id ? t.settings.display_id+' · ' : '')+'Version '+t.version+' · '+t.status+' · '+(t.mode==='workflow'?'Workflow':'Timeline'),'helper'));
    if (t.description) box.append(el('p',t.description));
    const columns = (t.settings?.summary_fields || []).map(id=>t.fields.find(f=>f.id === id)).filter(Boolean);
    for(const cell of t.settings?.summary_cells || []) {
      const field=t.fields.find(f=>f.id===cell.field_id);
      const column=field?.columns?.find(c=>c.id===cell.column_id);
      if(column) columns.push({id:[field.id,cell.row,column.id].join(':'),type:column.type,label:field.label+' · '+column.label+' (row '+(cell.row+1)+')'});
    }
    const subset = records.filter(row=>row.template_id===t.id);
    const sort = t.settings?.sort_field;
    if (sort) subset.sort((a,b)=>describe(a.summary_values?.[sort]).localeCompare(describe(b.summary_values?.[sort]),undefined,{numeric:true}));
    if(t.mode==='workflow' && t.settings?.stages?.length) {
      const board = el('div',null,'forms-stage-board');
      const lanes = [...t.settings.stages,{id:null,name:'Submitted'}];
      for(const lane of lanes) {
        const column=el('section',null,'forms-stage');
        const items=subset.filter(r=>r.stage_id===lane.id);
        column.append(el('h4',lane.name+' ('+items.length+')'));
        for(const row of items) column.append(link([row.created_by_name,date(row.updated_at)].join(' · '),()=>openRecord(row.id)));
        board.append(column);
      }
      box.append(board);
    }
    box.append(el('h3','Form records'),table(['Created by','Status',...columns.map(f=>f.label),'Updated'], subset.map(row=>[
      link(row.created_by_name || 'Open record',()=>openRecord(row.id)),badge(row.status),...columns.map(f=>describe(row.summary_values?.[f.id],f.type)),date(row.updated_at)
    ]),'No form records yet.'));
    host.append(box);
  }
  function edit(template) {
    const host = frame();
    editor = window.ClassifireFormsBuilder.mount(host,template,{
      roles,templates,staff, onPreview:preview, onOutline:outlineDialog,
      onSave:async value=>{
        const {id,version,name,description,mode,status,roles,settings,fields} = value;
        const saved = await api('template/save',{id,version,name,description,mode,status,roles,settings,fields});
        ++changeCount;
        if (status === 'published' && host.isConnected) {
          templates = [saved, ...templates.filter(template => template.id !== saved.id)];
          panel = 'templates';
          query = '';
          libraryView();
        }
        return saved;
      },
      onCancel:()=>refresh()
    });
  }
  async function history(t) {
    const stamp = generation, data = await api('template/history?id='+encodeURIComponent(t.id));
    if (stamp !== generation) return;
    const dialog = modal('Version history');
    dialog.append(table(['Version','Status','Changed by','Last saved',''],data.versions.map(v=>[
      v.version,badge(v.status),v.updated_by_name,date(v.updated_at),versionActions(v)
    ]),'No saved versions.'));
    function versionActions(v) {
      const actions = el('div',null,'actions');
      actions.append(button('Preview',async()=>{
        const version = await api('template?id='+encodeURIComponent(t.id)+'&version='+v.version);
        if(dialog.open) preview(version);
      }));
      if(v.version>1) actions.append(button('Compare changes',async()=>{
        const [before,after]=await Promise.all([v.version-1,v.version].map(n=>api('template?id='+encodeURIComponent(t.id)+'&version='+n)));
        if(!dialog.open)return;
        const changes=modal('Changes in version '+v.version), rows=[];
        const add=(label,a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b)) rows.push([label,readable(a),readable(b)]);};
        function readable(value) {
          if(value==null) return '—';
          if(Array.isArray(value)) return value.map(readable).join(', ');
          if(typeof value==='object') return Object.entries(value).filter(([k])=>!['id','data','image'].includes(k)).map(([k,v])=>k+' = '+readable(v)).join(' · ');
          return String(value);
        }
        for(const key of ['name','description','status','roles','mode']) add(key,before[key],after[key]);
        for(const key of new Set([...Object.keys(before.settings),...Object.keys(after.settings)])) add(key,before.settings[key],after.settings[key]);
        const oldFields=new Map(before.fields.map(f=>[f.id,f])), newFields=new Map(after.fields.map(f=>[f.id,f]));
        for(const id of new Set([...oldFields.keys(),...newFields.keys()])) {
          const old=oldFields.get(id), now=newFields.get(id);
          add(now?.label || old.label,old,now);
        }
        if(before.fields.map(f=>f.id).join()!==after.fields.map(f=>f.id).join()) add('Field order',before.fields.map(f=>f.label),after.fields.map(f=>f.label));
        changes.append(table(['Setting or field','Version '+(v.version-1),'Version '+v.version],rows,'No content changes.'));
        changes.showModal();
      }));
      if(v.version !== t.version) actions.append(button('Restore as draft', async()=>{
        const older = await api('template?id='+encodeURIComponent(t.id)+'&version='+v.version);
        if(!dialog.open) return;
        dialog.close(); edit({...older,version:t.version,status:'draft'});
      }));
      return actions;
    }
    dialog.showModal();
  }
  function stage(t,id) {return (t.settings?.stages || []).find(s=>s.id===id);}
  function attachments(host, items) {
    if (!items?.length) return;
    const list = el('ul',null,'forms-attachments');
    for(const item of items) {
      const li = el('li'),a = el('a',item.name);
      const data = item.data || '';
      if (!/^[A-Za-z0-9+/=]+$/.test(data) && !/^data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+$/.test(data)) continue;
      a.download = item.name; a.href='data:application/octet-stream;base64,'+data.slice(data.indexOf(',')+1); li.append(a); list.append(li);
    }
    if(list.children.length) host.append(el('h3','Template attachments'),list);
  }
  function photoAppendix(host, definition, values, perPage) {
    const appendix = el('section',null,'forms-photo-appendix');
    appendix.append(el('h3','Photo appendix'));
    function collect(fields, answers) {
      for (const field of fields) {
        if (field.hide_in_pdf) continue;
        const value = answers?.[field.id];
        if (['group','table'].includes(field.type) && Array.isArray(value)) value.forEach(row=>collect(field.children || field.columns || [],row));
        if (field.type !== 'photo' || !Array.isArray(value)) continue;
        for (const photo of value) {
          const video = ['video/mp4','video/webm'].includes(photo.type);
          if (!video && !['image/png','image/jpeg','image/webp','image/gif'].includes(photo.type)) continue;
          const figure = el('figure'), media = el(video ? 'video' : 'img');
          if(video) {media.controls=true;media.preload='metadata';media.setAttribute('aria-label',photo.name);} else media.alt=photo.name;
          media.src = 'data:'+photo.type+';base64,'+photo.data;
          const caption=el('figcaption',field.label+' · '+photo.name+(video?' ('+photo.type+')':''));
          if(['large','xl'].includes(field.photo_size)) {
            if(field.show_tags && photo.tags?.length) caption.append(el('p',photo.tags.join(', ')));
            if(field.show_description && photo.description) caption.append(el('p',photo.description));
          }
          figure.append(media,caption); appendix.append(figure);
        }
      }
    }
    collect(definition,values);
    const photos = Array.from(appendix.querySelectorAll('figure'));
    if (!photos.length) return;
    const count = [1,2,4,6,8,10].includes(perPage) ? perPage : 1;
    for(let i=0;i<photos.length;i+=count) {
      const page=el('section',null,'forms-photo-page forms-photos-'+count);
      page.append(...photos.slice(i,i+count));appendix.append(page);
    }
    host.append(appendix);
  }
  function mountForm(host,t,entry,options) {
    const paper = el('article', null, 'forms-paper forms-' + (t.settings?.orientation === 'landscape' ? 'landscape' : 'portrait'));
    window.ClassifireFormsLayout.render(paper,'header_layout',t,entry,options.printedAt);
    paper.append(el('h2',t.name || 'Untitled template')); if(t.settings?.display_id) paper.append(el('p',t.settings.display_id,'helper')); if(t.description) paper.append(el('p',t.description));
    if(t.settings?.header) paper.append(el('p',t.settings.header,'forms-paper-header'));
    attachments(paper,t.settings?.attachments);
    const body = el('div'); paper.append(body);
    if(t.settings?.photo_appendix && entry && options.readOnly) photoAppendix(paper,t.fields,entry.values,t.settings.photos_per_page);
    if(t.settings?.footer) paper.append(el('p',t.settings.footer,'forms-paper-footer'));
    window.ClassifireFormsLayout.render(paper,'footer_layout',t,entry,options.printedAt);
    host.append(paper);
    return window.ClassifireFormFields.mount(body,t,{values:entry?.values || {},staff,entries:records,member:window.ClassifireAccess.user,
      signerProfile:()=>api('signer'),
      calculate:async values=>{
        const tables = t.fields.filter(f=>f.type === 'table');
        const inputs = {};
        for(const field of tables) {
          // The formula parser only needs table inputs. Evidence bytes never leave the field just to update a total.
          const ids = new Set(field.columns.filter(c=>['text','textarea','number','date','datetime','time','choice','multichoice','yes_no','person','list_property','formula'].includes(c.type)).map(c=>c.id));
          inputs[field.id] = (values[field.id] || []).map(row=>Object.fromEntries(Object.entries(row).filter(([id])=>ids.has(id))));
        }
        return (await api('calculate',{fields:tables.map(({id,type,label,columns,table_mode})=>({id,type,label,columns,table_mode})),values:inputs})).values;
      },
      stageId:entry?.stage_id || t.settings?.stages?.[0]?.id,
      lockedStages:(entry?.approvals || []).map(a=>a.stage_id),...options});
  }
  function preview(t) {
    const dialog = modal('Template preview', true);
    dialog.classList.add('forms-preview');
    const host = el('div'); dialog.append(host);
    mountForm(host,t,null,{preview:true,onChange:()=>{}});
    dialog.showModal();
  }
  function entryView(t, entry = null) {
    const host = frame(), isNew = !entry, editable = isNew ? t.can_fill : entry.can_edit;
    const recordId = entry?.id || uid();
    const stageId = entry?.stage_id || (isNew ? t.settings?.stages?.[0]?.id : null);
    const currentStage = stage(t,stageId);
    const back = window.ClassifireFormControls.iconButton('Back to forms','back',()=>{mayDiscard().then(leave=>leave && refresh()).catch(report);});
    const controls = [back];
    const bar = el('section',null,'card forms-entry-toolbar');
    if (editable && entry?.status !== 'submitted') {
      controls.push(button('Save draft',()=>persist('draft')));
      if (t.mode !== 'workflow') controls.push(button('Submit form',()=>persist('submitted'),true));
    }
    if (t.mode === 'workflow' && (isNew ? editable && currentStage?.roles.includes(window.ClassifireAccess.user.role) : entry.can_approve)) {
      controls.push(button('Approve stage',()=>persist('approve'),true));
    }
    if (entry?.can_reopen) controls.push(button('Reopen previous stage',async()=>{
      if (busy() || !await mayDiscard()) return;
      if (!await window.CeasefireDialogs.confirm('Reopen previous stage?', 'The last approval will be withdrawn and recorded in the form history.', 'Reopen stage', 'Cancel')) return;
      pending=true;
      try {const reopened=await api('entry/reopen',{id:entry.id,version:entry.version});entryView(reopened.template,reopened);}
      finally {pending=false;}
    }));
    if (entry) controls.push(button('Download PDF',()=>downloadForm(entry,theme.value),true));
    bar.append(heading(isNew ? 'New form' : 'Form record',controls));
    const themeLabel = el('label',null,'field forms-pdf-theme'), theme = el('select');
    theme.append(...pdfThemes.map(([id,name])=>new Option(name,id)));
    theme.value = entry?.pdf_theme || 'ceasefire';
    theme.addEventListener('change',()=>{ if(editable) {dirty=true; ++changeCount;} });
    themeLabel.append(el('span','PDF colour theme'),theme); bar.append(themeLabel);
    const status = ['Template version '+t.version,entry?.status,currentStage?.name].filter(Boolean);
    bar.append(el('p',status.join(' · '),'helper')); host.append(bar);
    fields = mountForm(host,t,entry,{readOnly:!editable,onChange:()=>{dirty=true;++changeCount;}});
    workflowHistory(host,t,entry);
    async function persist(action) {
      if (busy() || (action !== 'draft' && !fields.validate())) return;
      pending = true;
      const data = {id:recordId, version:entry?.version || 0, template_id:t.id, template_version:t.version,values:fields.getValues(),pdf_theme:theme.value,status:action==='submitted' ? 'submitted' : 'draft'};
      host.inert=true; host.setAttribute('aria-busy','true');
      try {
        let saved = entry;
        if (action !== 'approve' || isNew || dirty || entry?.status === 'requested') {
          saved = await api('entry/save',data);
          entry = saved; dirty = false; ++changeCount;
        }
        if (action === 'approve') saved = await api('entry/approve',{id:saved.id,version:saved.version});
        entryView(saved.template || t,saved);
      } catch(error) {
        if(entry && entry.id === recordId && !dirty) {
          // If saving and advancing are separate operations, retry from the confirmed server version.
          entryView(t,entry);
        }
        report(error);
      } finally {host.inert=false;host.removeAttribute('aria-busy');pending=false;}
    }
  }
  function workflowHistory(host,t,entry) {
    if(entry?.approvals?.length) host.append(table(['Approved stage','Approved by','Date'],entry.approvals.map(a=>[stage(t,a.stage_id)?.name || a.stage_id,a.member_name,date(a.at)]),''));
    if(entry?.reversals?.length) host.append(table(['Reopened stage','Reopened by','Date'],entry.reversals.map(a=>[stage(t,a.stage_id)?.name || a.stage_id,a.member_name,date(a.at)]),''));
  }
  async function downloadForm(entry, theme) {
    if (busy()) return;
    pending = true;
    try {
      const query = new URLSearchParams({id:entry.id,version:String(entry.version),theme});
      const response = await fetch('/api/forms/entry/pdf?' + query, {cache:'no-store'});
      if (!response.ok) throw new Error((await response.json()).error || 'The form PDF could not be downloaded.');
      const blob = await response.blob();
      const filename = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url; link.download = filename ? decodeURIComponent(filename) : 'CLASSIFIRE-Form.pdf';
      document.body.append(link); link.click(); link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    } finally { pending = false; }
  }
  window.ClassifireForms = {activate:refresh,leave,hasUnsavedChanges:changed,isBusy:busy,revision:()=>changeCount};
})();
