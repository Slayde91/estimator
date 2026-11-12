(() => {
  'use strict';
  const tr = source => window.CeasefireI18n?.translate(source) || source;
  const node = (tag, cls, source) => {
    const item = document.createElement(tag); if(cls)item.className=cls;
    if(source!==undefined){item.textContent=source;window.CeasefireI18n?.text(item,source);}
    return item;
  };
  const button = (label, run, cls='button secondary') => {
    const item=node('button',cls,label);item.type='button';item.addEventListener('click',run);return item;
  };
  const field = (label, control) => {const item=node('label','field');item.append(node('span','',label),control);return item;};
  function attach(host, options) {
    const owner=options.owner ? {...options.owner} : null;
    let alive=true,busy=false,loaded=false,version=0,state={notes:[],files:[]},readTicket=0,noteEditor=null;
    const requests=new Set();
    const actor=window.ClassifireAccess?.user?.id || null;
    const notes=node('details','card commercial-side-panel record-resource-panel'),files=node('details','card commercial-side-panel record-resource-panel');
    notes.open=files.open=true;host.append(notes,files);
    const current=()=>alive && host.isConnected && actor===(window.ClassifireAccess?.user?.id || null) && (options.isCurrent?.() ?? true);
    const editable=()=>current() && loaded && !!owner && !busy && (options.canEdit?.() ?? (!window.ClassifireAccess || window.ClassifireAccess.can('edit')));
    const query=()=>new URLSearchParams(owner || {}).toString();
    const hint=node('p','helper record-resource-status');hint.setAttribute('role','status');
    function message(source,error=false) {
      if(!current())return;
      hint.textContent=tr(source);hint.classList.toggle('error',error);
      if(error)options.message?.(source,true);
    }
    async function request(action, data) {
      const controller=new AbortController();requests.add(controller);
      const timeout=setTimeout(()=>controller.abort(),data===undefined?8000:30000);
      try {
        const response=await fetch('/api/record-resources'+action,{cache:'no-store',signal:controller.signal,...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,...data})})});
        const value=await response.json();if(!response.ok){const error=Error(value.error || 'The request could not be completed.');error.status=response.status;throw error;}return value;
      } catch(error) {
        // An interrupted write may already have committed. Keep its old version;
        // never replay it automatically. A deliberate retry remains CAS checked.
        if(error.name==='AbortError')throw Error('The request could not be completed.');
        throw error;
      } finally {clearTimeout(timeout);requests.delete(controller);}
    }
    function summary(label,count) {const item=node('summary');item.append(node('span','',label),document.createTextNode(' ('+count+')'));return item;}
    const values = rows => rows.map(({id,title,body})=>({id,title,body}));
    async function refresh() {
      if(!owner || !current())return;
      const ticket=++readTicket;
      try {const result=await request('?'+query());if(!current() || ticket!==readTicket)return;version=result.version;state=result;loaded=true;paint();message('');}
      catch(error){if(current() && ticket===readTicket){loaded=false;paint();message(error.message,true);}}
    }
    async function save(action,data) {
      if(!editable())return false;
      busy=true;paint();
      try {const result=await request('/'+action,{version,...data});if(!current())return false;++readTicket;version=result.version;state=result;message('Saved');return true;}
      catch(error){if(current()){if(error.status===409)await refresh();message(error.message,true);}throw error;}
      finally{busy=false;if(current())paint();}
    }
    function closeNote() {if(noteEditor){const editor=noteEditor;noteEditor=null;editor.dialog.close();editor.dialog.remove();}}
    function noteDirty(){return !!noteEditor && (noteEditor.title.value!==noteEditor.original.title || noteEditor.body.value!==noteEditor.original.body);}
    async function leave() {
      if(busy){message('Finish saving Notes or Files before leaving this record.',true);return false;}
      if(noteDirty() && !await window.CeasefireDialogs.confirm(tr('Discard unsaved note changes?'),'',tr('Discard'),tr('Cancel')))return false;
      closeNote();return true;
    }
    function openNote(existing) {
      if(!editable() || noteEditor)return;
      const original=existing || {id:crypto.randomUUID(),title:'',body:''};
      const dialog=node('dialog','record-note-dialog'),form=node('form','record-note-form'),title=node('input'),body=node('textarea');
      title.value=original.title;title.maxLength=300;title.required=true;body.value=original.body;body.maxLength=8000;body.rows=8;
      dialog.setAttribute('aria-label',tr(existing?'Edit note':'New note'));
      const status=node('p','helper');status.setAttribute('role','status');
      noteEditor={dialog,title,body,original:{...original}};
      const actions=node('div','actions');
      const cancel=button('Cancel',()=>void leave());
      let conflict=false;
      const submit=node('button','button primary','Save');submit.type='submit';
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(!editable() || !form.reportValidity())return;
        if(conflict && !await window.CeasefireDialogs.confirm(tr('Notes or Files changed. Save this note using the latest record?'),'',tr('Save'),tr('Cancel')))return;
        if(!editable() || noteEditor?.dialog!==dialog)return;
        const note={id:original.id,title:title.value,body:body.value};
        submit.disabled=cancel.disabled=true;
        try{if(await save('notes',{notes:[note,...values(state.notes.filter(item=>item.id!==note.id))]}))closeNote();}
        catch(error){if(current() && dialog.isConnected){conflict=error.status===409;status.textContent=tr(error.message);}}
        finally{if(dialog.isConnected)submit.disabled=cancel.disabled=false;}
      });
      dialog.addEventListener('cancel',event=>{event.preventDefault();void leave();});
      dialog.addEventListener('close',()=>{if(noteEditor?.dialog===dialog)noteEditor=null;dialog.remove();});
      actions.append(cancel,submit);form.append(node('h2','',existing?'Edit note':'New note'),field('Note title',title),field('Note',body),status,actions);dialog.append(form);document.body.append(dialog);dialog.showModal();title.focus();
    }
    async function removeNote(item) {
      if(!editable() || !await window.CeasefireDialogs.confirm(tr('Delete this note?'),item.title,tr('Delete'),tr('Cancel')) || !editable())return;
      try{await save('notes',{notes:values(state.notes.filter(note=>note.id!==item.id))});}catch(_){}
    }
    async function removeFile(item) {
      if(!editable() || !await window.CeasefireDialogs.confirm(tr('Remove this file?'),item.name,tr('Remove'),tr('Cancel')) || !editable())return;
      try{await save('remove-file',{file_id:item.id});}catch(_){}
    }
    async function upload(list) {
      if(!editable())return;
      for(const file of list){
        if(!editable())return;
        if(file.size>12*1024*1024){message('Each document file must be 12 MiB or smaller.',true);return;}
        busy=true;paint();
        try {
          const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('The file could not be read.'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
          if(!current())return;
          const result=await request('/upload',{version,filename:file.name,content_base64:encoded});
          if(!current())return;++readTicket;version=result.version;state=result;message('Saved');
        }catch(error){if(current()){if(error.status===409)await refresh();message(error.message,true);}return;}
        finally{busy=false;if(current())paint();}
      }
    }
    function paint() {
      if(!alive)return;
      const notesOpen=notes.open,filesOpen=files.open;
      const create=button('New note',()=>openNote(null));create.disabled=!editable();
      notes.replaceChildren(summary('Notes',state.notes.length),create);
      for(const item of [...state.notes].sort((a,b)=>b.updated_at.localeCompare(a.updated_at))){
        const row=node('article','record-resource-note'),title=node('button','text-button project-title-button');title.type='button';title.textContent=item.title;title.addEventListener('click',()=>openNote(item));title.disabled=!editable();
        const remove=button('Delete',()=>void removeNote(item),'text-button');remove.disabled=!editable();
        const body=node('p','record-resource-note-body');body.textContent=item.body;
        const meta=node('small');meta.textContent=[item.author,item.updated_at ? new Date(item.updated_at).toLocaleString() : ''].filter(Boolean).join(' · ');
        row.append(title,body,meta,remove);notes.append(row);
      }
      const input=node('input');input.type='file';input.multiple=true;input.hidden=true;
      input.addEventListener('change',()=>void upload([...input.files]));
      const add=button('Add files',()=>input.click());add.disabled=!editable();files.replaceChildren(summary('Files',state.files.length),add,input);
      for(const item of state.files){
        const row=node('div','record-resource-file'),link=node('a');link.textContent=item.name;link.href='/api/record-resources/file?'+query()+'&file='+encodeURIComponent(item.id);link.download=item.name;
        link.addEventListener('click',event=>{if(!current())event.preventDefault();});
        const size=node('small');size.textContent=(item.size/1024).toFixed(1)+' KB';
        const remove=button('Remove',()=>void removeFile(item),'text-button');remove.disabled=!editable();row.append(link,size,remove);files.append(row);
      }
      const reload=button('Refresh',()=>void refresh());reload.disabled=busy || !owner;files.append(reload,hint);
      if(!owner)message('Save this record before adding Notes or Files.');
      notes.open=notesOpen;files.open=filesOpen;
    }
    paint();queueMicrotask(()=>{if(current()){paint();void refresh();}});
    return {pending:()=>busy,dirty:noteDirty,fingerprint:()=>noteEditor?JSON.stringify([noteEditor.original.id,noteEditor.title.value,noteEditor.body.value]):'',leave,refresh,
      close(){alive=false;++readTicket;for(const request of requests)request.abort();closeNote();notes.remove();files.remove();}};
  }
  window.ClassifireRecordResources={attach};
})();
