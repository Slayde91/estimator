(() => {
  'use strict';
  const fields = {name:'Name', title:'Title', phone:'Phone', email:'Email', company:'Company',
    billing_address:'Billing address', abn_acn:'ABN/ACN'};
  const contactFields = ['name','title','phone','email'];
  function node(tag, text, cls) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  }
  function label(tag, text, cls) {
    const element = node(tag, text, cls);
    window.CeasefireI18n?.text(element, text);
    return element;
  }
  function button(text, click) {
    const item = label('button', text, 'button secondary');
    item.type = 'button';
    item.addEventListener('click', click);
    return item;
  }
  function compare(form, inputs, current, onRefresh, readOnly) {
    const box = node('fieldset', null, 'contacts-group');
    box.dataset.enquiryCompare = '';
    form.append(box);
    function paint() {
      const person = current();
      box.hidden = !person;
      if (!person) return;
      box.replaceChildren(label('legend', 'Contact details'));
      const table = node('table'), head = table.createTHead().insertRow(), body = table.createTBody();
      for (const title of ['Field','This enquiry','Current Contact']) head.append(label('th', title));
      const selected = new Map();
      for (const key of contactFields) {
        const row = body.insertRow(), old = inputs[key].value, next = person[key] || '';
        row.append(label('th',fields[key]), node('td', old || '—'));
        const directory = row.insertCell();
        if (old !== next && !readOnly) {
          const choice = node('label',null,'contacts-link-option'), check = node('input');
          check.type = 'checkbox';
          check.setAttribute('aria-label', 'Select '+fields[key]);
          const i18n = window.CeasefireI18n;
          i18n?.attr(check,'aria-label','Select {0}',[i18n.term(fields[key])]);
          choice.append(check, document.createTextNode(next || '—'));
          directory.append(choice); selected.set(key, check);
        } else directory.textContent = next || '—';
      }
      const company = body.insertRow();
      company.append(label('th','Company'), node('td',inputs.company.value || '—'),node('td',person.company || '—'));
      box.append(table);
      if (selected.size) {
        const apply = button('Refresh from contact', () => {
          for (const [key, check] of selected) if (check.checked) inputs[key].value = person[key] || '';
          onRefresh(); paint();
        });
        apply.disabled = true;
        for (const check of selected.values()) check.addEventListener('change', () => {
          apply.disabled = ![...selected.values()].some(item => item.checked);
        });
        box.append(apply);
      }
    }
    for (const key of [...contactFields,'company']) inputs[key].addEventListener('input', paint);
    paint();
    return paint;
  }

  function format(person) {
    return [person.name, person.company, person.email, person.abn_acn].filter(Boolean).join(' · ');
  }
  function identityFields(kind) {
    return kind === 'accounts' ? ['company','billing_address','abn_acn'] : [...contactFields,'company'];
  }
  function suggestions(form, kind, inputs, record, request, selectedContact) {
    const area = node('details',null,'contacts-group crm-identity-section');
    const summary = label('summary','Possible duplicates'), list = node('ul');
    area.append(summary,list); area.hidden = true; form.append(area);
    let timer, generation = 0;
    form.addEventListener('input', event => {
      const field = event.target.name;
      if (!['name','company','email','phone','abn_acn'].includes(field)) return;
      clearTimeout(timer); const ticket = ++generation;
      area.hidden = true;
      if (kind === 'leads' && selectedContact()) return;
      timer = setTimeout(async () => {
        const target = kind === 'accounts' ? 'accounts' : 'contacts';
        const values = Object.fromEntries(identityFields(target).map(key=>[key,inputs[key]?.value || '']));
        if (!(target === 'accounts' ? values.company : values.name).trim()) return;
        try {
          const result = await request('identity/suggestions', {kind:target,id:kind==='leads'?null:record.id,fields:values});
          if (ticket !== generation || !form.isConnected) return;
          list.replaceChildren();
          for (const item of result.matches) {
            const row = node('li',format(item.fields) + ' — ');
            item.reasons.forEach((reason,i) => {if(i)row.append(', ');row.append(label('span',reason));});
            list.append(row);
          }
          area.hidden = !result.matches.length; area.open = true;
        } catch { /* Save checks again and reports actionable errors. */ }
      }, 250);
    });
  }

  function management(form, kind, record, directory, request, done, dirty) {
    if (!record.id || !(window.ClassifireAccess?.can('admin') ?? true)) return;
    const box = node('details',null,'contacts-group crm-identity-section crm-merge-records'), section = node('div',null,'contacts-links-body');
    box.append(label('summary','Merge records'), section); form.append(box);
    const choose = node('select'), sourceLabel = node('label',null,'field');
    const sourceCaption = label('span','Source record');
    sourceCaption.id = 'identity-source-'+record.id;
    choose.setAttribute('aria-labelledby',sourceCaption.id);
    choose.append(new Option('—',''));
    choose.disabled = true;
    sourceLabel.append(sourceCaption,choose);
    const review = node('div'), status = node('p',null,'helper');
    status.setAttribute('role','status');
    let loading = false, loaded = false;
    box.addEventListener('toggle', async () => {
      if (!box.open || loaded || loading) return;
      loading = true;
      try {
        const values = Object.fromEntries(identityFields(kind).map(key=>[key,record[key] || '']));
        const result = await request('identity/suggestions',{kind,id:record.id,fields:values});
        if (!form.isConnected) return;
        if (result.version !== directory.version) throw new Error('Contacts have changed. Reopen the form to review the latest values.');
        const survivors = new Set(Object.values(directory.identity_aliases?.[kind] || {}));
        for (const match of result.matches) {
          if (!survivors.has(match.id)) choose.add(new Option(format(match.fields),match.id));
        }
        choose.disabled = choose.options.length === 1;
        status.replaceChildren();
        if (choose.disabled) status.append(label('span',kind === 'accounts' ? 'No matching companies.' : 'No matching Contacts.'));
        loaded = true;
      } catch (error) {
        if (form.isConnected) status.replaceChildren(label('span',error.message));
      } finally { loading = false; }
    });
    const preview = button('Review merge', async () => {
      if (!choose.value) return;
      if (dirty()) {status.replaceChildren(label('span','Save or cancel your edits before merging records.'));return;}
      preview.disabled = true; choose.disabled = true; review.replaceChildren();status.replaceChildren();
      try {
        const source = choose.value, survivor = record.id;
        const pair = await request('identity/preview', {kind,source_id:source,survivor_id:survivor});
        if (!form.isConnected) return;
        if (pair.version !== directory.version) throw new Error('Contacts have changed. Reopen the form to review the latest values.');
        const table = node('table'), tr = table.createTHead().insertRow();
        for (const title of ['Field','Source record','Surviving record']) tr.append(label('th',title));
        const body = table.createTBody();
        for (const [key,title] of Object.entries(fields)) {
          if (!(key in pair.source) && !(key in pair.survivor)) continue;
          body.insertRow().append(label('th',title),node('td',pair.source[key] || '—'),node('td',pair.survivor[key] || '—'));
        }
        body.insertRow().append(label('th','Record ID'),node('td',pair.source_ids.join(', ')),node('td',pair.survivor_ids.join(', ')));
        const kinds = {contacts:'Contacts',companies:'Companies',projects:'Projects',leads:'Leads',quotes:'Quotes',work_orders:'Work Orders',
          purchase_orders:'Purchase Orders',certifications:'Certifications',swms:'SWMS',converted_leads:'Converted leads',active_leads:'Leads'};
        for (const key of Object.keys(pair.source_links.counts)) {
          body.insertRow().append(label('th', kinds[key] || key),node('td',pair.source_links.counts[key]),node('td',pair.survivor_links.counts[key]));
        }
        review.append(table);
        const resourcesNotice = label('p','Source Notes and Files stay on the original record. Undo the merge to access them again.');
        resourcesNotice.className = 'helper'; review.append(resourcesNotice);
        if ([pair.source_links,pair.survivor_links].some(state=>state.scan_pending || state.error_count))
          review.append(label('p','Some project records are still loading or unavailable.'));
        const why = node('label',null,'field'), reason = node('input');
        reason.maxLength = 500; why.append(label('span','Reason for merge'),reason); review.append(why);
        const requestId = crypto.randomUUID();
        const confirm = button('Confirm merge', async () => {
          if (!reason.value.trim() || dirty()) return;
          confirm.disabled = true; choose.disabled = true; preview.disabled = true; reason.readOnly = true;
          try {
            await request('identity/merge', {kind,source_id:source,survivor_id:survivor,reason:reason.value,
              version:pair.version,preview_token:pair.preview_token,request_id:requestId});
            await done();
          } catch(error) {status.replaceChildren(label('span',error.message));confirm.disabled=false;choose.disabled=false;preview.disabled=false;reason.readOnly=false;}
        });
        confirm.disabled = true; reason.addEventListener('input',()=>{confirm.disabled=!reason.value.trim();});
        review.append(confirm);
      } catch(error) {status.replaceChildren(label('span',error.message));}
      finally {choose.disabled=false;preview.disabled=!choose.value;}
    });
    preview.disabled = true; choose.addEventListener('change',()=>{preview.disabled=!choose.value;review.replaceChildren();});
    section.append(sourceLabel,preview,review,status);
    for (const merge of directory.identity_merges?.[kind] || []) {
      if (merge.survivor_id !== record.id) continue;
      const history = node('details'), title = node('summary',merge.source_label || merge.source_id);
      history.append(title,node('p',[merge.reason,merge.actor_name,merge.merged_at].filter(Boolean).join(' · ')));
      const original = node('dl','', 'kanban-card-details');
      for (const [field,title] of Object.entries(fields)) {
        if (field in merge.source_fields) original.append(label('dt',title),node('dd',merge.source_fields[field] || '—'));
      }
      history.append(original);
      const requestId = crypto.randomUUID(), undo = button('Undo merge', async () => {
        if (dirty()) {status.replaceChildren(label('span','Save or cancel your edits before merging records.'));return;}
        undo.disabled = true;
        try {await request('identity/undo', {kind,operation_id:merge.operation_id,request_id:requestId,version:directory.version});await done();}
        catch(error){status.replaceChildren(label('span',error.message));undo.disabled=false;}
      });
      history.append(undo);section.append(history);
    }
  }
  window.ClassifireIdentity = {compare,management,suggestions};
})();
