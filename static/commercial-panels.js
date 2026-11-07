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
    section.append(el("summary", count === undefined ? label : `${label} (${count})`));
    return section;
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
    dialog.className = "commercial-note-dialog"; dialog.setAttribute("aria-label", "Work Order note");
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
  function attach(form, options) {
    const owner = form.parentElement, wrapper = el("div"), left = el("aside"), right = el("aside");
    wrapper.className = "commercial-work-layout"; left.className = right.className = "commercial-sidebar";
    owner.insertBefore(wrapper,form); wrapper.append(left,form,right);
    const accountPanel = panel("Account Details"), contactPanel = panel("Contact Details");
    left.append(accountPanel,contactPanel);
    let directory = {};
    function showContact() {
      const details = options.fields.details, fold = s => (s || "").trim().toLowerCase();
      const account=directory.accounts?.find(a=>fold(a.company)===fold(details.client));
      const matches=account ? directory.contacts.filter(c=>c.account_id===account.id && ((details.email && fold(c.email)===fold(details.email)) || (details.contact && fold(c.name)===fold(details.contact)))) : [];
      const contact=matches.length===1 ? matches[0] : null;
      accountPanel.querySelector("dl")?.remove(); contactPanel.querySelector("dl")?.remove();
      fieldList(accountPanel,[["Company",account?.company || details.client],["Billing address",account?.billing_address],["Site address",details.site_address]]);
      fieldList(contactPanel,[["Name",contact?.name || details.contact],["Title",contact?.title],["Phone",contact?.phone || details.phone],["Email",contact?.email || details.email]]);
    }
    showContact();
    fetch("/api/contacts/directory",{cache:"no-store"}).then(r=>r.ok?r.json():{}).then(data=>{
      if (!wrapper.isConnected) return;
      directory=data; showContact();
    }).catch(()=>{});
    form.querySelector(".commercial-details")?.addEventListener("input",showContact);
    const notes = panel("Notes",0), files = panel("Files",0);
    right.append(notes, files);
    let showAllNotes=false;
    function repaintNotes() {
      const all=[...(options.fields.notes || [])].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
      notes.replaceChildren(el("summary",`Notes (${all.length})`), action("New note",()=>openNote(null,options,repaintNotes),"button secondary"));
      for(const note of showAllNotes ? all : all.slice(0,3)) {
        const card=el("article"); card.className="commercial-note-card";
        card.append(action(note.title,()=>openNote(note,options,repaintNotes)),el("small",new Date(note.updated_at).toLocaleString("en-AU")+" · "+note.author),el("p",plain(note.body).slice(0,180)));
        notes.append(card);
      }
      if(all.length>3) notes.append(action(showAllNotes?"Show less":"View all notes",()=>{showAllNotes=!showAllNotes;repaintNotes();}));
    }
    function repaintFiles() {
      const attached = options.fields.files || [];
      files.replaceChildren(el("summary",`Files (${attached.length})`));
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
    form.querySelector(".commercial-order-fields").append(uploadLabel);
    if(options.fields.order.attachments) uploadLabel.append(el("small","Existing file references: "+options.fields.order.attachments));
    repaintNotes(); repaintFiles();
    const quotePanel=panel("Linked Quotes",0), purchasePanel=panel("Linked Purchase Orders",0);
    function showRelated() {
      for(const [block,name,rows] of [
        [quotePanel,"Linked Quotes", options.related.filter(d=>d.kind==="quote" && d.id===options.fields.order.quote_id)],
        [purchasePanel,"Linked Purchase Orders",options.related.filter(d=>d.kind==="purchase_order" && d.fields.order.work_order_id===options.id)]
      ]) {
        block.replaceChildren(el("summary",`${name} (${rows.length})`));
        for(const doc of rows) block.append(action([doc.reference || doc.last_number,doc.fields.title].filter(Boolean).join(" · "),()=>options.openRelated(doc)));
      }
    }
    right.append(quotePanel,purchasePanel); showRelated();
    form.querySelector("[data-order-link]")?.addEventListener("change",showRelated);
    return {repaintFiles};
  }
  window.ClassifireWorkOrderPanels = {attach};
})();
