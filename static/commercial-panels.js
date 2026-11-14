(() => {
  "use strict";
  const el = (tag, text) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    return item;
  };
  function action(text, run, style = "text-button") {
    const button = el("button", text);
    button.type = "button"; button.className = style;
    button.addEventListener("click", run);
    return button;
  }
  function panel(label, count) {
    const section = el("details"); section.className = "card commercial-side-panel"; section.open = true;
    section.append(panelSummary(label,count));
    return section;
  }
  function panelSummary(label,count) {
    const summary=el('summary'),name=el('span',label);
    window.CeasefireI18n?.text(name,label);summary.append(name);
    if(count!==undefined)summary.append(document.createTextNode(` (${count})`));
    return summary;
  }
  function fieldList(container, values) {
    const list = el("dl"); list.className = "commercial-card-info";
    for (const [name, value] of values) list.append(el("dt",name), el("dd",value || "—"));
    container.append(list);
  }
  function plain(html) {
    const template = el("template"); template.innerHTML = html;
    return template.content.textContent.trim();
  }
  function noteDialog({existing, label, richEditor, save, remove, onClose}) {
    const dialog=el("dialog"), form=el("form"), title=el("input"), status=el("span");
    const text=(item,key)=>{item.textContent=key;window.CeasefireI18n?.text(item,key);return item;};
    const attr=(item,key,value)=>{item.setAttribute(key,value);window.CeasefireI18n?.attr(item,key,value);};
    dialog.className="commercial-note-dialog";attr(dialog,"aria-label",label);
    title.value=existing?.title || "";title.maxLength=300;attr(title,"aria-label","Note title");
    const titleLabel=el("label");titleLabel.className="field";titleLabel.append(text(el("span"),"Title"),title);
    const original={title:title.value,body:existing?.body || ""};
    let body=original.body,busy=false;
    const dirty=()=>title.value!==original.title || body!==original.body;
    const changed=()=>text(status,"Unsaved changes");
    const editor=richEditor("Compose text",body,value=>{body=value;},changed);
    title.addEventListener("input",changed);status.setAttribute("role","status");
    const actions=el("div");actions.className="actions";
    const close=()=>{if(!busy && dialog.open)dialog.close();};
    async function finish(deleting){
      if(busy)return;
      if(!deleting && !dirty()){close();return;}
      if(!deleting && !title.value.trim()){text(status,"Enter a title for the note.");title.focus();return;}
      if(deleting && !await window.CeasefireDialogs.confirm("Delete this note?",original.title,"Delete","Cancel"))return;
      if(!dialog.open || busy)return;
      busy=true;form.inert=true;dialog.setAttribute("aria-busy","true");
      try{
        const saved=deleting ? await remove() : await save({title:title.value.trim(),body},body!==original.body);
        if(saved!==false && dialog.open)dialog.close();
      }catch(error){status.textContent=error.message;}
      finally{busy=false;form.inert=false;dialog.removeAttribute("aria-busy");}
    }
    const control=(name,run,style)=>text(action(name,run,style),name);
    const del=control("Delete",()=>existing ? void finish(true) : close(),"button secondary");
    const done=control("Done",()=>void finish(false),"button primary"), cancel=control("Cancel",close,"button secondary");
    actions.append(del,cancel,status,done);
    form.addEventListener("submit",event=>{event.preventDefault();void finish(false);});
    form.append(text(el("h2"),existing ? "Edit note" : "New note"),titleLabel,editor,actions);
    dialog.append(form);document.body.append(dialog);
    dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
    dialog.addEventListener("close",()=>{dialog.remove();onClose?.();},{once:true});
    dialog.showModal();title.focus();
    return {dialog,dirty,fingerprint:()=>JSON.stringify([title.value,body])};
  }
  function openNote(existing,options,repaint) {
    const label={quote:"Quote note",work_order:"Work Order note",purchase_order:"Purchase Order note"}[options.kind];
    const id=existing?.id || crypto.randomUUID();
    return noteDialog({existing,label,richEditor:options.richEditor,
      async save(values){
        const response=await fetch("/api/scheduler/bootstrap",{cache:"no-store"}).catch(()=>null);
        const profile=response?.ok ? await response.json().catch(()=>null) : null;
        const note={...values,id,author:profile?.user?.name || "Local user",updated_at:new Date().toISOString()};
        await options.writeNotes([note,...(options.fields.notes || []).filter(item=>item.id!==id)]);repaint();
      },
      async remove(){await options.writeNotes((options.fields.notes || []).filter(item=>item.id!==id));repaint();}
    });
  }
  // Shared, editable directory searches use the same +/clear pattern as Projects.
  // Values are copied into this document only; the directory and Project stay unchanged.
  const fold = value => String(value || "").trim().replace(/\s+/g," ").toLocaleLowerCase();
  let directoryRequest;
  function loadDirectory(refresh=false) {
    if(refresh)directoryRequest=null;
    if(directoryRequest)return directoryRequest;
    const pending=fetch("/api/contacts/directory",{cache:"no-store"}).then(async response=>{
      const data=await response.json();if(!response.ok)throw Error(data.error || "Contacts could not be loaded.");return data;
    }).finally(()=>{if(directoryRequest===pending)directoryRequest=null;});
    directoryRequest=pending;return pending;
  }
  function directorySearch(label, options) {
    const wrap=el("div"), caption=el("label",label), search=el("div"), input=el("input"), popup=el("div"), add=el("button");
    const id="commercial-directory-"+crypto.randomUUID();
    wrap.className="field project-account-field commercial-directory-field";search.className="project-account-search";
    caption.htmlFor=id;window.CeasefireI18n?.text(caption,label);input.id=id;input.type="search";input.value=options.value || "";
    input.setAttribute("role","combobox");input.setAttribute("aria-autocomplete","list");input.setAttribute("aria-controls",id+"-options");input.setAttribute("aria-expanded","false");input.autocomplete="off";
    const placeholder=options.kind==='accounts' ? 'Search Companies' : 'Search contacts';
    window.CeasefireI18n?.attr(input,'placeholder',placeholder);input.placeholder ||= placeholder;
    input.setAttribute('aria-label',label);window.CeasefireI18n?.attr(input,'aria-label',label);
    popup.id=id+"-options";popup.className="project-account-options commercial-directory-options";popup.setAttribute('role','listbox');popup.hidden=true;
    add.type='button';add.className='project-account-add';
    const title=options.kind==='accounts'?'New Company':'New Contact';add.title=title;add.setAttribute('aria-label',title);
    window.CeasefireI18n?.attr(add,'title',title);window.CeasefireI18n?.attr(add,'aria-label',title);
    const symbol=el('span','+');symbol.className='button-symbol add-symbol';symbol.setAttribute('aria-hidden','true');add.append(symbol);
    search.append(input);if(options.allowCreate!==false)search.append(add);wrap.append(caption,search,popup);
    let records={accounts:[],contacts:[]}, matches=[],active=-1,requested=false,sequence=0,creating=false;
    const current=()=>wrap.isConnected && options.isCurrent() && !input.disabled;
    function close(){requested=false;active=-1;popup.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
    function choose(item){if(!current())return;close();options.onSelect(item,records);input.value=options.read();}
    function render(){
      if(!requested || !current() || document.activeElement!==input)return;
      const query=fold(input.value);
      matches=(records[options.kind] || []).filter(item=> (!options.filter || options.filter(item,records)) && fold(options.kind==='accounts'?item.company:item.name).includes(query)).slice(0,30);active=-1;
      popup.replaceChildren(...matches.map((item,index)=>{
        let label=options.kind==='accounts'?item.company:item.name;
        if(options.kind==='contacts' && matches.some(other=>other.id!==item.id && fold(other.name)===fold(item.name))){
          label=[item.name,item.company,item.email,item.phone].filter(Boolean).join(' · ');
        }
        const option=el('button',label);option.type='button';option.tabIndex=-1;option.id=id+'-'+index;
        option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.setAttribute('aria-posinset',String(index+1));option.setAttribute('aria-setsize',String(matches.length));option.dataset.directoryId=item.id;
        option.addEventListener('mousedown',event=>event.preventDefault());option.addEventListener('click',()=>choose(item));return option;
      }));
      if(!matches.length){const empty=el('p');const source=options.kind==='accounts'?'No matching Companies.':'No matching Contacts.';window.CeasefireI18n?.text(empty,source);empty.textContent ||= source;popup.append(empty);}
      popup.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
    }
    async function request(){
      requested=true;const ticket=++sequence;
      try{const result=await loadDirectory();if(ticket!==sequence || !current())return;records=result;options.onDirectory?.(result);render();}
      catch(error){if(ticket===sequence && current())options.message(error.message,true);}
    }
    input.addEventListener('focus',()=>void request());
    input.addEventListener('input',()=>{if(!current())return;options.onInput(input.value);requested=true;render();});
    input.addEventListener('blur',close);
    input.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='Escape' && !popup.hidden){event.preventDefault();event.stopPropagation();close();}
      else if(['ArrowDown','ArrowUp'].includes(event.key) && !popup.hidden && matches.length){
        event.preventDefault();active=Math.max(0,Math.min(matches.length-1,active+(event.key==='ArrowDown'?1:-1)));
        [...popup.children].forEach((node,index)=>node.setAttribute('aria-selected',String(index===active)));
        input.setAttribute('aria-activedescendant',popup.children[active].id);popup.children[active].scrollIntoView({block:'nearest'});
      }else if(event.key==='Enter' && !popup.hidden && active>=0){event.preventDefault();choose(matches[active]);}
    });
    add.addEventListener('click',async()=>{
      if(creating || !current())return;creating=true;add.disabled=true;close();const value=input.value;
      try {
        const account=await options.account?.(records);
        if(!current() || input.value!==value)return;
        const saved=options.kind==='accounts' ? await window.ClassifireContacts.createAccount({company:value,isCurrent:current}) : await window.ClassifireContacts.createContact({name:value,isCurrent:current,...(account?{account_id:account.id}:{})});
        const latest=await loadDirectory(true);
        if(!current() || input.value!==value || !saved)return;
        records=latest;options.onDirectory?.(latest);choose(saved);
      } catch(error){if(current())options.message(error.message,true);}
      finally{creating=false;if(wrap.isConnected)add.disabled=false;}
    });
    return {element:wrap,input,refresh(){if(document.activeElement!==input)input.value=options.read();if(!current())close();},close};
  }
  function linkedContacts(kind, fields, project, participants, directory) {
    const rows=[], seen=new Map(), contacts=new Map((directory.contacts || []).map(contact=>[contact.id,contact]));
    const aliases=directory.identity_aliases?.contacts || {}, details=fields.details || {}, order=fields.order || {};
    function add(id, role, snapshot={}, primary=false) {
      if(!id && !snapshot.name)return;
      const canonical=aliases[id] || id, prior=id && seen.get(canonical);
      if(prior){if(!prior.roles.includes(role))prior.roles.push(role);return;}
      const contact=id ? contacts.get(canonical) : null;
      const row={id:canonical || '',contact:contact || null,
        name:(primary && snapshot.name) || contact?.name || snapshot.name || 'Contact unavailable',
        phone:(primary ? snapshot.phone : undefined) ?? contact?.phone ?? snapshot.phone ?? '',
        email:(primary ? snapshot.email : undefined) ?? contact?.email ?? snapshot.email ?? '',
        title:contact?.title || '',roles:[role],primary};
      rows.push(row);if(id)seen.set(canonical,row);
    }
    if(kind==='purchase_order') {
      add(order.supplier_contact_id,'Supplier contact',{name:order.supplier_contact,email:order.supplier_email},true);
      return rows;
    }
    const samePerson=details.contact_id && project.contact_id===details.contact_id;
    add(details.contact_id,samePerson ? 'Primary contact' : 'Client contact',
      {name:details.contact,phone:details.phone,email:details.email},true);
    if(!samePerson && (project.contact_id || project.contact_name!==details.contact))
      add(project.contact_id,'Project contact',{name:project.contact_name,phone:project.contact_phone,email:project.contact_email});
    add(fields.billing?.contact_id,'Billing contact',{name:fields.billing?.name,phone:fields.billing?.phone,email:fields.billing?.email});
    for(const participant of participants?.participants || [])if(participant.kind==='contacts')
      add(participant.id,participants.roles?.[participant.role] || participant.role,{name:participant.label});
    for(const party of participants?.linked_parties || [])if(party.kind==='contacts')
      add(party.id,party.role,{name:party.label});
    return rows;
  }
  function linkedCompanies(kind, fields, project, participants, directory) {
    const rows=[],seen=new Map(),aliases=directory.identity_aliases?.accounts || {},accounts=new Map((directory.accounts || []).map(row=>[row.id,row]));
    function add(id,role,label='',primary=false) {
      if(!id && !label)return;
      const canonical=aliases[id] || id,prior=id && seen.get(canonical);
      if(prior){if(!prior.roles.includes(role))prior.roles.push(role);return;}
      const account=accounts.get(canonical),row={id:canonical || '',account:account || null,name:(primary && label) || account?.company || label || 'Company unavailable',roles:[role],primary};
      rows.push(row);if(id)seen.set(canonical,row);
    }
    const details=fields.details || {},order=fields.order || {};
    if(kind==='purchase_order') {
      add(order.supplier_account_id,'Supplier',order.supplier,true);
      return rows;
    }
    add(details.account_id,'Client',details.client,true);
    const sameCompany=project.account_id ? project.account_id===details.account_id : project.client===details.client;
    if(!sameCompany)add(project.account_id,'Main Client',project.client);
    add(fields.billing?.account_id,'Billing company');
    for(const party of participants?.participants || [])if(party.kind==='accounts')add(party.id,participants.roles?.[party.role] || party.role,party.label);
    for(const party of participants?.linked_parties || [])if(party.kind==='accounts')add(party.id,party.role,party.label);
    for(const row of linkedContacts(kind,fields,project,participants,directory))if(row.contact?.account_id)add(row.contact.account_id,'Contact company',row.contact.company);
    return rows;
  }
  function recipientSearches(fields, projectDetails, change, options) {
    let directory = {};
    const searchOptions = {
      isCurrent:options.isCurrent, message:options.message, allowCreate:options.allowCreate,
      onDirectory(data) { directory = data; options.onDirectory?.(data); }
    };
    function accountFor(id, name, data = directory) {
      const matches = (data.accounts || []).filter(row => id ? row.id === id : fold(row.company) === fold(name));
      return matches.length === 1 ? matches[0] : null;
    }
    const documentAccount = (records) => accountFor(fields.details.account_id, fields.details.client, options.readDirectory?.() || records || directory);
    function companyValues(account, value = '') {
      const project = projectDetails();
      const same = account?.id && (!project.account_id || account.id === project.account_id) && fold(account.company) === fold(project.client);
      return {client:account?.company || value, account_id:account?.id || '',
        billing_address:same ? project.billing_address || '' : account?.billing_address || '',
        abn_acn:same ? project.abn_acn || '' : account?.abn_acn || ''};
    }
    function changeCompany(value, account = null) {
      const changed = account ? account.id !== fields.details.account_id : value !== fields.details.client;
      if (changed || account) change({...companyValues(account, value), ...(changed ? {contact:'', contact_id:'', phone:'', email:''} : {})});
    }
    const company = directorySearch(options.companyLabel || 'Company', {...searchOptions, kind:'accounts', value:fields.details.client,
      read:() => fields.details.client, onInput:changeCompany, onSelect:account => changeCompany(account.company, account)});
    const name = directorySearch(options.contactLabel || 'Name', {...searchOptions, kind:'contacts', value:fields.details.contact,
      read:() => fields.details.contact,
      account(records) {
        if (fields.details.account_id) return {id:fields.details.account_id};
        const name = fields.details.client;
        return documentAccount(records) || (name && loadDirectory().then(data => accountFor('', name, data)));
      },
      filter(contact) {
        const account = documentAccount();
        return !fields.details.client || !!account && (contact.account_id === account.id || contact.account_id === undefined && fold(contact.company) === fold(account.company));
      },
      onInput(value) { if (value !== fields.details.contact) change({contact:value, contact_id:'', phone:'', email:''}); },
      onSelect(contact, data) {
        const account = accountFor(contact.account_id, contact.company, data);
        change({...companyValues(account, contact.company || ''), contact:contact.name, contact_id:contact.id, phone:contact.phone || '', email:contact.email || ''});
      }
    });
    return [company, name];
  }
  window.ClassifireCommercialDirectory={field:directorySearch,load:loadDirectory,fold,linkedContacts,linkedCompanies,recipientSearches};
  function attach(form, options) {
    const owner = form.parentElement, wrapper = el("div"), left = el("aside"), right = el("aside");
    const panelActor=window.ClassifireAccess?.user?.id || null;
    const panelCurrent=()=>wrapper.isConnected && panelActor===(window.ClassifireAccess?.user?.id || null) && (options.isCurrent?.() ?? true);
    const isPurchaseOrder=options.kind==='purchase_order';
    wrapper.className = "commercial-work-layout"+(isPurchaseOrder?' commercial-purchase-layout':''); left.className = right.className = "commercial-sidebar";
    owner.insertBefore(wrapper,form); wrapper.append(left,form,right);
    const linkedProjects=panel("Linked Projects");
    linkedProjects.classList.add("commercial-linked-projects");
    function showLinkedProjects(data, message="") {
      const sourceIdentity=JSON.stringify(options.participantSource?.());
      const rows=[],seen=new Set();
      for(const bid of [...(data?.linked_bids || []),...(data?.other_site_bids || [])]) {
        const identity=JSON.stringify([bid.source || "",bid.owner || "",bid.project_no || "",bid.site_address || ""]);
        if(seen.has(identity))continue;seen.add(identity);rows.push(bid);
      }
      linkedProjects.replaceChildren(panelSummary("Linked Projects",data ? rows.length : undefined));
      for(const bid of rows) {
        const label=[bid.project_no,bid.client,bid.site_address].filter(Boolean).join(" · ");
        if(bid.availability==="available" && bid.source) {
          linkedProjects.append(action(label,async event=>{
            if(!panelCurrent() || sourceIdentity!==JSON.stringify(options.participantSource?.()))return;
            await window.CeasefireCommercial?.openLinkedProject(bid,event.currentTarget);
          }));
        } else {
          const item=el("p",label);item.className="helper";
          if(bid.availability==="unavailable"){const note=el("span","Saved project unavailable");window.CeasefireI18n?.text(note,"Saved project unavailable");item.append(" · ",note);}
          else if(bid.availability==="unverified"){const note=el("span","Availability not yet verified");window.CeasefireI18n?.text(note,"Availability not yet verified");item.append(" · ",note);}
          linkedProjects.append(item);
        }
      }
      const copy=message || (data?.error_count || data?.scan_pending ? "Some linked projects could not be checked." : data && !rows.length ? "No linked projects." : "");
      if(copy){const note=el("p",copy);note.className="helper";window.CeasefireI18n?.text(note,copy);linkedProjects.append(note);}
    }
    let controls=[],refreshDetails=()=>{},refreshDirectory=async()=>{},reloadParties;
    const history=window.ClassifireCrmActivity.historyPanel(options.readActivity,panelCurrent,
      isPurchaseOrder ? 'purchase-order-activity-heading' : options.kind+'-activity-heading',
      {write:options.writeActivity, canWrite:()=>options.isSaved() && options.canEdit()});
    {
    const accountPanel = panel("Linked Companies"), contactPanel = panel("Linked Contacts");
    left.append(accountPanel,contactPanel,history.element);
    let directory = {},participants=null,participantsKey='',participantTicket=0;
    const contactList=el('div'),companyList=el('div'),linkedNotice=el('p');contactList.className='commercial-linked-contacts';companyList.className='commercial-linked-companies';
    linkedNotice.className='helper';linkedNotice.setAttribute('role','status');
    const current=panelCurrent;
    // A Project save can rehydrate canonical IDs after the document was saved.
    // Always read the captured editor owner; never infer its contact by name.
    const projectDetails=()=>options.readProjectDetails?.() || options.projectDetails || {};
    async function refreshParticipants(force=false) {
      if(!current())return;
      const identity=options.participantSource?.(),key=JSON.stringify(identity);
      if(!force && key===participantsKey)return;
      participantsKey=key;const ticket=++participantTicket;participants=null;linkedNotice.textContent='';
      if(!identity){showLinkedProjects(null,"Save the Project to view linked projects.");showContact();return;}
      showLinkedProjects(null,"Loading…");
      try {
        const response=await fetch('/api/crm/project-participants?project='+encodeURIComponent(identity.selector),{cache:'no-store'}),data=await response.json();
        if(!response.ok)throw Error(data.error || 'Linked contacts could not be loaded.');
        if(!current() || ticket!==participantTicket || key!==JSON.stringify(options.participantSource?.()))return;
        if(identity.revision && data.project_revision!==identity.revision)throw Error('The project changed. Reopen its details before changing participants.');
        participants=data;showContact();showLinkedProjects(data);
      }catch(error){if(current() && ticket===participantTicket){linkedNotice.textContent=error.message;showContact();showLinkedProjects(null,error.message);}}
    }
    refreshDirectory=async function(value) {
      const latest=value || await loadDirectory(true);if(!current())return;directory=latest;showContact();
    };
    reloadParties=()=>Promise.all([refreshDirectory(),refreshParticipants(true)]);
    async function editContact(id) {
      if(!current())return;
      try {
        await window.ClassifireContacts.editContact(id,{isCurrent:current});
        if(current())await refreshDirectory();
      }catch(error){if(current())options.message(error.message,true);}
    }
    async function editAccount(id) {
      if(!current())return;
      try {
        await window.ClassifireContacts.editAccount(id,{isCurrent:current});
        if(current())await refreshDirectory();
      }catch(error){if(current())options.message(error.message,true);}
    }
    function showLinkedCompanies() {
      companyList.replaceChildren();
      for(const row of linkedCompanies(options.kind,options.fields,projectDetails(),participants,directory)) {
        const card=el('article');card.className='commercial-linked-company';if(row.id)card.dataset.accountId=row.id;
        card.append(row.account ? action(row.name,()=>void editAccount(row.id),'text-button project-title-button') : el('strong',row.name));
        const roles=el('p');roles.className='helper';
        row.roles.forEach((role,index)=>{if(index)roles.append(' · ');const label=el('span',role);window.CeasefireI18n?.text(label,role);roles.append(label);});card.append(roles);
        const docCompany=!isPurchaseOrder && row.primary ? options.fields.details : null;
        fieldList(card,[["Billing address",docCompany?.billing_address ?? row.account?.billing_address],
          ["ABN/ACN",docCompany?.abn_acn ?? row.account?.abn_acn]]);
        if(row.id && !row.account){const unavailable=el('p','The selected directory record is unavailable.');unavailable.className='helper';window.CeasefireI18n?.text(unavailable,unavailable.textContent);card.append(unavailable);}
        companyList.append(card);
      }
    }
    function showLinkedContacts() {
      contactList.replaceChildren();
      const rows=linkedContacts(options.kind,options.fields,projectDetails(),participants,directory);
      for(const row of rows) {
        const card=el('article');card.className='commercial-linked-contact';if(row.id)card.dataset.contactId=row.id;
        const name=row.contact ? action(row.name,()=>void editContact(row.id),'text-button project-title-button') : el('strong',row.name);
        card.append(name);
        const roles=el('p');roles.className='helper';
        row.roles.forEach((role,index)=>{if(index)roles.append(' · ');const label=el('span',role);window.CeasefireI18n?.text(label,role);roles.append(label);});card.append(roles);
        fieldList(card,[["Title",row.title],["Phone",row.phone],["Email",row.email]]);
        if(row.id && !row.contact){const unavailable=el('p','The selected directory record is unavailable.');unavailable.className='helper';window.CeasefireI18n?.text(unavailable,unavailable.textContent);card.append(unavailable);}
        contactList.append(card);
      }
      if(!isPurchaseOrder && !rows.length){const empty=el('p','No linked contacts.');empty.className='helper';window.CeasefireI18n?.text(empty,'No linked contacts.');contactList.append(empty);}
    }
    const [company, name] = isPurchaseOrder ? [] : recipientSearches(options.fields, projectDetails,
      values => { options.changeDetails(values); showContact(); }, {
        isCurrent:options.canEdit, message:options.message, readDirectory:() => directory,
        onDirectory(data) { directory=data; showContact(); }
      });
    if(!isPurchaseOrder){accountPanel.append(company.element);contactPanel.append(name.element);controls=[company,name];}
    accountPanel.append(companyList);
    const refreshContacts=action('',async()=>{
      if(!current())return;
      try {await refreshDirectory();await refreshParticipants(true);}catch(error){if(current())options.message(error.message,true);}
    },'button secondary icon-only commercial-refresh-contacts');
    refreshContacts.title='Refresh linked contacts';refreshContacts.setAttribute('aria-label','Refresh linked contacts');
    window.CeasefireI18n?.attr(refreshContacts,'title','Refresh linked contacts');window.CeasefireI18n?.attr(refreshContacts,'aria-label','Refresh linked contacts');
    const refreshSymbol=el('span');refreshSymbol.className='button-symbol pricing-action-symbol pricing-reset-symbol';refreshSymbol.setAttribute('aria-hidden','true');
    const existingRefresh=document.querySelector('#reset-pricing svg');
    if(existingRefresh)refreshSymbol.append(existingRefresh.cloneNode(true));
    else refreshSymbol.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 7v5h-5"></path><path d="M4 17v-5h5"></path><path d="M6.1 8.4A7.5 7.5 0 0 1 19.2 10L20 12"></path><path d="M17.9 15.6A7.5 7.5 0 0 1 4.8 14L4 12"></path></svg>';
    refreshContacts.append(refreshSymbol);contactPanel.append(contactList,linkedNotice,refreshContacts);
    contactPanel.addEventListener('toggle',()=>{if(contactPanel.open)void refreshParticipants(true);});
    linkedProjects.addEventListener('toggle',()=>{if(linkedProjects.open)void refreshParticipants(true);});
    function showContact() {
      showLinkedCompanies();showLinkedContacts();
      controls.forEach(control=>control.refresh());
    }
    showContact();
    loadDirectory().then(data=>{if(!current())return;directory=data;showContact();}).catch(error=>{if(current())linkedNotice.textContent=error.message;});
    void refreshParticipants();
    form.querySelector(".commercial-details")?.addEventListener("input",showContact);
    if(isPurchaseOrder)form.querySelector('[data-order-field="supplier_email"]')?.addEventListener("input",showContact);
    refreshDetails=()=>{showContact();void refreshParticipants();};
    }
    const notes = panel("Notes",0), files = panel("Files",0);
    right.append(notes, files);
    let showAllNotes=false;
    function repaintNotes() {
      const all=[...(options.fields.notes || [])].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
      notes.replaceChildren(panelSummary('Notes',all.length), action("New note",()=>openNote(null,options,repaintNotes),"button secondary"));
      for(const note of showAllNotes ? all : all.slice(0,3)) {
        const card=el("article"); card.className="commercial-note-card";
        card.append(action(note.title,()=>openNote(note,options,repaintNotes)),el("small",new Date(note.updated_at).toLocaleString("en-AU")+" · "+note.author),el("p",plain(note.body).slice(0,180)));
        notes.append(card);
      }
      if(all.length>3) notes.append(action(showAllNotes?"Show less":"View all notes",()=>{showAllNotes=!showAllNotes;repaintNotes();}));
    }
    function repaintFiles() {
      const attached = options.visibleFiles ? options.visibleFiles() : options.fields.files || [];
      files.replaceChildren(panelSummary('Files',attached.length));
      files.append(action("Add files",()=>upload.click(),"button secondary"));
      for(const file of attached){
        const row=el("div"); row.className="commercial-attached-file";
        const remove=action("",()=>{options.removeFile(file);repaintFiles();},"button secondary icon-only library-delete-button trash-button");
        remove.setAttribute("aria-label","Remove "+file.name); remove.title="Remove "+file.name;
        for(const attr of ["aria-label","title"])window.CeasefireI18n?.attr(remove,attr,"Remove {0}",[file.name]);
        const icon=el("span");icon.className="trash-artwork";icon.setAttribute("aria-hidden","true");remove.append(icon);
        row.append(action(file.name,()=>options.download(file).catch(e=>options.message(e.message,true))),el("small",`${(file.size/1024).toLocaleString("en-AU",{maximumFractionDigits:1})} KB`), remove);
        files.append(row);
      }
    }
    const uploadLabel=el("label"); uploadLabel.className="field";
    const upload=el("input"); upload.type="file"; upload.multiple=true; upload.setAttribute("aria-label","Attach files");
    upload.addEventListener("change",async()=>{
      try {await options.upload([...upload.files]);} catch(e){options.message(e.message,true);} finally {upload.value="";repaintFiles();}
    });
    uploadLabel.append(el("span","Attach files"),upload);
    const inlineFiles=form.querySelector('.commercial-work-cost-files');
    if(inlineFiles)inlineFiles.append(uploadLabel);
    else {uploadLabel.hidden=true;form.append(uploadLabel);}
    if(options.fields.order.attachments) uploadLabel.append(el("small","Existing file references: "+options.fields.order.attachments));
    repaintNotes(); repaintFiles();
    const relatedPanels = options.kind==='quote' ? [["Linked Work Orders",panel("Linked Work Orders",0)],["Linked Purchase Orders",panel("Linked Purchase Orders",0)]]
      : options.kind==='purchase_order' ? [["Linked Work Orders",panel("Linked Work Orders",0)],["Linked Quotes",panel("Linked Quotes",0)]]
      : [["Linked Quotes",panel("Linked Quotes",0)],["Linked Purchase Orders",panel("Linked Purchase Orders",0)]];
    function showRelated() {
      const related=options.readRelated();
      const workOrders=related.filter(d=>d.kind==='work_order' &&
        (options.kind==='purchase_order' ? d.id===options.fields.order.work_order_id : d.fields.order.quote_id===options.id));
      const quoteIds=new Set(options.kind==='purchase_order' ? [options.fields.order.quote_id,...workOrders.map(d=>d.fields.order.quote_id)] : [options.fields.order.quote_id]);
      const workIds=new Set(workOrders.map(d=>d.id));
      for(const [name,block] of relatedPanels) {
        const rows=name==='Linked Work Orders' ? workOrders : name==='Linked Quotes'
          ? related.filter(d=>d.kind==='quote' && quoteIds.has(d.id))
          : related.filter(d=>d.kind==='purchase_order' && (options.kind==='quote'
            ? workIds.has(d.fields.order.work_order_id) || d.fields.order.quote_id===options.id
            : d.fields.order.work_order_id===options.id));
        block.replaceChildren(panelSummary(name,rows.length));
        for(const doc of rows) block.append(action([doc.reference || doc.last_number,doc.fields.title].filter(Boolean).join(" · "),()=>options.openRelated(doc)));
      }
    }
    relatedPanels.forEach(([,block])=>right.append(block));right.append(linkedProjects);showRelated();
    form.querySelector("[data-order-link]")?.addEventListener("change",showRelated);
    return {repaintFiles,refreshDirectory,refreshHistory:history.refresh,updateActivity:history.update,activityDirty:history.dirty,
      refreshRecords(){showRelated();repaintFiles();return Promise.all([reloadParties(),history.refresh()]);},
      closeSearches(){controls.forEach(control=>control.close());},refreshProjectDetails(value){options.projectDetails=value;refreshDetails();}};
  }
  window.ClassifireWorkOrderPanels = {attach,noteDialog,plain};
})();
