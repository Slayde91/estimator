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
  function openNote(existing, options, repaint) {
    const dialog = el("dialog"), content = el("form"), title = el("input"), hint = el("span");
    const noteLabel = {quote:"Quote note",work_order:"Work Order note",purchase_order:"Purchase Order note"}[options.kind];
    dialog.className = "commercial-note-dialog"; dialog.setAttribute("aria-label", noteLabel);
    window.CeasefireI18n?.attr(dialog,'aria-label',noteLabel);
    title.maxLength = 300; title.setAttribute("aria-label", "Note title");
    title.value = existing?.title || "";
    const note = existing ? {...existing} : {id:crypto.randomUUID(),title:"",body:"",author:"Local user",updated_at:""};
    const label = el("label","Title"); label.className = "field"; label.append(title);
    hint.setAttribute("role", "status");
    let timer, pending = false, saving = null, removing = false;
    const author = fetch("/api/scheduler/bootstrap", {cache:"no-store"}).then(r => r.ok ? r.json() : {}).then(data=>data.user?.name || "Local user").catch(()=>"Local user");
    async function flush() {
      clearTimeout(timer);
      if (saving) { await saving; if (!pending) return; }
      if (!pending || !title.value.trim()) return;
      pending = false;
      saving = (async()=>{
        note.title = title.value.trim(); note.updated_at = new Date().toISOString(); note.author = await author;
        await options.writeNotes([note, ...(options.fields.notes || []).filter(x=>x.id!==note.id)]);
        hint.textContent = options.isSaved() ? "Saved" : "Saved to this draft"; repaint();
      })();
      try { await saving; } catch (e) { pending=true; hint.textContent=e.message; throw e; } finally { saving=null; }
    }
    function edit() {
      pending = true; hint.textContent = "Unsaved changes"; clearTimeout(timer);
      timer = setTimeout(()=>flush().catch(()=>{}),750);
    }
    async function done() {
      if (removing) return;
      if (pending && !title.value.trim() && plain(note.body)) { hint.textContent="Enter a title for the note."; title.focus(); return; }
      try { await flush(); if (pending && title.value.trim()) await flush(); dialog.close(); }
      catch (error) { hint.textContent = error.message; }
    }
    title.addEventListener("input", edit);
    const body = options.richEditor("Compose text", note.body, value=>{ note.body=value; }, edit);
    const actions = el("div"); actions.className = "actions";
    actions.append(action("Delete", async()=>{
      if (!window.confirm("Delete this note?")) return;
      removing = true; clearTimeout(timer);
      try {
        if (saving) await saving;
        await options.writeNotes((options.fields.notes || []).filter(x=>x.id!==note.id)); repaint(); dialog.close();
      } catch (error) { removing=false; hint.textContent=error.message; }
    }, "button secondary"), hint, action("Done", done, "button primary"));
    content.addEventListener("submit",event=>{event.preventDefault();void done();});
    content.append(el("h2",existing ? "Edit note" : "New note"),label,body,actions); dialog.append(content);
    document.body.append(dialog); dialog.addEventListener("close",()=>{clearTimeout(timer);dialog.remove();});
    dialog.addEventListener("cancel",event=>{event.preventDefault();void done();});
    dialog.showModal(); title.focus();
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
    add.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M8 4v8M4 8h8"></path></svg>';
    search.append(input,add);wrap.append(caption,search,popup);
    let records={accounts:[],contacts:[]}, matches=[],active=-1,requested=false,sequence=0,creating=false;
    const current=()=>wrap.isConnected && options.isCurrent() && !input.disabled;
    function close(){requested=false;active=-1;popup.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
    function choose(item){if(!current())return;close();options.onSelect(item,records);input.value=options.read();}
    function render(){
      if(!requested || !current() || document.activeElement!==input)return;
      const query=fold(input.value);
      matches=(records[options.kind] || []).filter(item=> (!options.filter || options.filter(item,records)) && fold(options.kind==='accounts'?item.company:item.name).includes(query)).slice(0,30);active=-1;
      popup.replaceChildren(...matches.map((item,index)=>{
        const option=el('button',options.kind==='accounts'?item.company:item.name);option.type='button';option.tabIndex=-1;option.id=id+'-'+index;
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
        const account=options.account?.(records);
        const saved=options.kind==='accounts' ? await window.ClassifireContacts.createAccount({company:value}) : await window.ClassifireContacts.createContact({name:value,...(account?{account_id:account.id}:{})});
        const latest=await loadDirectory(true);
        if(!current() || input.value!==value || !saved)return;
        records=latest;options.onDirectory?.(latest);choose(saved);
      } catch(error){if(current())options.message(error.message,true);}
      finally{creating=false;if(wrap.isConnected)add.disabled=false;}
    });
    return {element:wrap,input,refresh(){if(document.activeElement!==input)input.value=options.read();if(!current())close();},close};
  }
  window.ClassifireCommercialDirectory={field:directorySearch,load:loadDirectory,fold};
  function attach(form, options) {
    const owner = form.parentElement, wrapper = el("div"), left = el("aside"), right = el("aside");
    wrapper.className = "commercial-work-layout"; left.className = right.className = "commercial-sidebar";
    owner.insertBefore(wrapper,form); wrapper.append(left,form,right);
    const accountPanel = panel("Company Details"), contactPanel = panel("Contact Details");
    left.append(accountPanel,contactPanel);
    let directory = {}, controls=[];
    const projectAccount=()=>{const rows=(directory.accounts || []).filter(account=>fold(account.company)===fold(options.fields.details.client));return rows.length===1?rows[0]:null;};
    function change(values){options.changeDetails(values);showContact();}
    function changeCompany(value){change(value!==options.fields.details.client?{client:value,contact:'',phone:'',email:''}:{client:value});}
    const company=directorySearch('Company',{kind:'accounts',value:options.fields.details.client,read:()=>options.fields.details.client,isCurrent:options.canEdit,message:options.message,
      onDirectory(data){directory=data;showContact();},onInput(value){changeCompany(value);},onSelect(account){changeCompany(account.company);}});
    const name=directorySearch('Name',{kind:'contacts',value:options.fields.details.contact,read:()=>options.fields.details.contact,isCurrent:options.canEdit,message:options.message,
      account:projectAccount,filter(contact,data){const account=projectAccount();return !options.fields.details.client || !!account && (contact.account_id===account.id || contact.account_id===undefined && fold(contact.company)===fold(account.company));},
      onDirectory(data){directory=data;showContact();},onInput(value){change(value?{contact:value}:{client:'',contact:'',phone:'',email:''});},onSelect(contact,data){
        const accounts=(data.accounts || []).filter(account=>contact.account_id ? account.id===contact.account_id : fold(account.company)===fold(contact.company));const account=accounts.length===1?accounts[0]:null;
        change({client:account?.company || contact.company || '',contact:contact.name,phone:contact.phone || '',email:contact.email || ''});}});
    const site=el('label'),siteCaption=el('span','Site address'),siteInput=el('input');site.className='field commercial-site-address';
    window.CeasefireI18n?.text(siteCaption,'Site address');siteInput.value=options.fields.details.site_address || '';siteInput.setAttribute('aria-label','Site address');window.CeasefireI18n?.attr(siteInput,'aria-label','Site address');
    siteInput.addEventListener('input',()=>{if(options.canEdit())change({site_address:siteInput.value});});site.append(siteCaption,siteInput);
    accountPanel.append(company.element,site);contactPanel.append(name.element);controls=[company,name];
    function showContact() {
      const details=options.fields.details,project=options.projectDetails || {},account=projectAccount();
      const matches=(directory.contacts || []).filter(contact=>fold(contact.name)===fold(details.contact) && (!details.email || fold(contact.email)===fold(details.email)) && (!details.phone || fold(contact.phone)===fold(details.phone)));
      const contact=matches.length===1 ? matches[0] : null;
      accountPanel.querySelector('dl')?.remove();contactPanel.querySelector('dl')?.remove();
      const sameProject=fold(project.client)===fold(details.client);
      const companyList=el('div');fieldList(companyList,[["Billing address",sameProject ? project.billing_address ?? account?.billing_address : account?.billing_address],["ABN/ACN",sameProject ? project.abn_acn ?? account?.abn_acn : account?.abn_acn]]);
      accountPanel.insertBefore(companyList.firstChild,site);
      fieldList(contactPanel,[["Title",contact?.title],["Phone",details.phone],["Email",details.email]]);
      controls.forEach(control=>control.refresh());if(document.activeElement!==siteInput)siteInput.value=details.site_address || '';
    }
    showContact();
    loadDirectory().then(data=>{if(!wrapper.isConnected)return;directory=data;showContact();}).catch(()=>{});
    form.querySelector(".commercial-details")?.addEventListener("input",showContact);
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
      const attached = options.fields.files || [];
      files.replaceChildren(panelSummary('Files',attached.length));
      files.append(action("Add files",()=>upload.click(),"button secondary"));
      for(const file of attached){
        const row=el("div"); row.className="commercial-attached-file";
        row.append(action(file.name,()=>options.download(file).catch(e=>options.message(e.message,true))),el("small",`${(file.size/1024).toLocaleString("en-AU",{maximumFractionDigits:1})} KB`), action("Remove",()=>{options.removeFile(file);repaintFiles();}));
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
      const workOrders=options.related.filter(d=>d.kind==='work_order' &&
        (options.kind==='purchase_order' ? d.id===options.fields.order.work_order_id : d.fields.order.quote_id===options.id));
      const quoteIds=new Set(options.kind==='purchase_order' ? [options.fields.order.quote_id,...workOrders.map(d=>d.fields.order.quote_id)] : [options.fields.order.quote_id]);
      const workIds=new Set(workOrders.map(d=>d.id));
      for(const [name,block] of relatedPanels) {
        const rows=name==='Linked Work Orders' ? workOrders : name==='Linked Quotes'
          ? options.related.filter(d=>d.kind==='quote' && quoteIds.has(d.id))
          : options.related.filter(d=>d.kind==='purchase_order' && (options.kind==='quote'
            ? workIds.has(d.fields.order.work_order_id) || d.fields.order.quote_id===options.id
            : d.fields.order.work_order_id===options.id));
        block.replaceChildren(panelSummary(name,rows.length));
        for(const doc of rows) block.append(action([doc.reference || doc.last_number,doc.fields.title].filter(Boolean).join(" · "),()=>options.openRelated(doc)));
      }
    }
    relatedPanels.forEach(([,block])=>right.append(block));showRelated();
    form.querySelector("[data-order-link]")?.addEventListener("change",showRelated);
    return {repaintFiles,closeSearches(){controls.forEach(control=>control.close());},refreshProjectDetails(value){options.projectDetails=value;showContact();}};
  }
  window.ClassifireWorkOrderPanels = {attach};
})();
