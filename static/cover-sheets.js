(() => {
  'use strict';
  const host=document.getElementById('documentation-pdf-rows');
  if(!host)return;
  const status=document.getElementById('cover-sheets-status'),state={rows:new Map(),loaded:false,opening:null,saving:false};
  const text=(element,source,args=[])=>{
    if(window.CeasefireI18n)return window.CeasefireI18n.text(element,source,args);
    element.textContent=source.replace(/\{(\d+)\}/g,(_,n)=>typeof args[n]==='function'?args[n]():args[n]??'');return element;
  };
  const attr=(element,name,source,args=[])=>{
    if(window.CeasefireI18n)return window.CeasefireI18n.attr(element,name,source,args);
    element.setAttribute(name,source.replace(/\{(\d+)\}/g,(_,n)=>typeof args[n]==='function'?args[n]():args[n]??''));return element;
  };
  const term=source=>()=>window.CeasefireI18n?.translate?.(source)||source;
  const node=tag=>document.createElement(tag);
  function message(element,source,error=false){text(element,source);element.className=error?'message error':'helper';window.CeasefireNotifications?.show(element);}
  async function request(path,body){
    const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    let value;
    try{value=await response.json();}
    catch{const error=new Error('The cover sheet result could not be confirmed. Retry the same button to recover it.');error.uncertain=true;throw error;}
    if(!response.ok){const error=new Error(value.error||'Cover sheet settings could not be saved. Your selected file is kept.');error.status=response.status;error.uncertain=response.status>=500;throw error;}
    return value;
  }
  function validate(value){
    if(!value||typeof value.kind!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(value.kind)||typeof value.label!=='string'||value.label.length>160||
      !Number.isInteger(value.version)||value.version<1||typeof value.cover_pdf_name!=='string'||value.cover_pdf_name.length>200||typeof value.has_cover!=='boolean')throw new Error('The saved cover-sheet settings are invalid.');
    return value;
  }
  // Saved rows contain metadata only. Uploads and deletions remain drafts
  // until the main Save action, including safe retries after lost replies.
  const changed=row=>row.conflicted||row.draft!==undefined;
  function dirtyStatus() {
    const target=document.getElementById('cover-sheets-dirty');
    if(!target)return;
    const unsaved=[...state.rows.values()].some(changed);
    text(target,unsaved?'Unsaved changes':'');target.hidden=!unsaved;
  }
  function render(row){
    const present=row.draft===undefined?row.current.has_cover:!!row.draft;
    row.filename.textContent=present?(row.name||'Cover sheet.pdf'):'';
    row.file.disabled=state.saving||row.reading||row.busy||!!row.pending;
    row.remove.disabled=state.saving||row.reading||row.busy||!!row.pending||!present;
    row.fileCell.setAttribute('aria-busy',String(row.reading||row.busy));
    dirtyStatus();
  }
  function createRow(item){
    const fileCell=node('td'),actionCell=node('td'),file=node('input'),filename=node('p'),notice=node('p'),actions=node('div'),remove=node('button');
    fileCell.className='document-cover-file';actionCell.className='document-cover-actions';
    file.type='file';file.accept='.pdf,application/pdf';file.id='cover-sheet-'+item.kind;
    attr(file,'aria-label','PDF cover sheet for {0}',[term(item.label)]);
    filename.className='helper';notice.className='helper';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
    remove.type='button';remove.className='button secondary icon-only';actions.className='cover-sheet-actions';
    attr(remove,'aria-label','Delete cover sheet for {0}',[term(item.label)]);attr(remove,'title','Delete cover sheet for {0}',[term(item.label)]);
    // Constant application artwork, never user-supplied markup.
    remove.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"></path></svg>';
    const line=node('div'),picker=node('label'),caption=node('span');
    line.className='document-cover-picker';picker.className='compact-file-picker';text(caption,'Choose file');
    filename.id=file.id+'-name';file.setAttribute('aria-describedby',filename.id);
    picker.append(caption,file);line.append(picker,filename);fileCell.append(line,notice);actions.append(remove);actionCell.append(actions);
    const row={current:item,draft:undefined,name:item.cover_pdf_name,revision:0,reading:false,busy:false,pending:null,conflicted:false,fileCell,actionCell,file,filename,notice,remove};
    file.addEventListener('change',()=>upload(row));remove.addEventListener('click',()=>{
      if(row.remove.disabled)return;
      row.draft=row.current.has_cover?null:undefined;row.name='';row.revision++;
      // Cancelling a new upload leaves no operation to reconcile. A cover
      // created by another window must not become an implicit deletion.
      if(row.draft===undefined)row.conflicted=false;
      text(row.notice,'');render(row);
    });render(row);return row;
  }
  async function upload(row){
    const file=row.file.files?.[0];if(!file||state.saving||row.reading||row.busy||row.pending)return;
    if((!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')||!file.size||file.size>10*1024*1024||file.name.length>200||/[\/\\\x00-\x1f]/.test(file.name)){
      message(row.notice,'Choose a PDF cover sheet smaller than 10 MB.',true);row.file.value='';return;
    }
    row.reading=true;render(row);const endActivity=window.CeasefireActivity?.begin();
    try{
      const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('The PDF cover sheet could not be read.'));reader.readAsDataURL(file);});
      const next='data:application/pdf;base64,'+String(value).split(',')[1];
      if(!/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(next))throw new Error('The PDF cover sheet could not be read.');
      row.draft=next;row.name=file.name;row.revision++;text(row.notice,'');
    }catch(error){message(row.notice,error.message,true);}
    finally{row.reading=false;row.file.value='';render(row);endActivity?.();}
  }
  async function perform(row,operation){
    if(row.reading||row.busy||row.pending&&row.pending.operation!==operation||operation==='save'&&!row.pending&&!row.draft)return false;
    const endActivity=window.CeasefireActivity?.begin();row.busy=true;render(row);
    try{
      if(row.conflicted&&!row.pending){
        const accepted=await window.CeasefireDialogs.confirm('Cover sheet changed','This cover sheet was changed in another window. Apply your cover-sheet change?','Apply cover-sheet change','Keep editing');
        if(!accepted)return false;
        const latest=await request('/api/pdf-covers');
        const current=(latest.items||[]).find(value=>value.kind===row.current.kind);
        validate(current);row.current=current;
      }
      // A removal is an operation payload, not an edit to the selected file.
      // Cancellation or a definite conflict must leave that upload available.
      const action=row.pending||{operation,cover_pdf:operation==='remove'?null:row.draft,cover_pdf_name:operation==='remove'?'':row.name,expected_version:row.current.version};
      row.pending=action;render(row);message(row.notice,'Saving…');
      const saved=validate(await request('/api/pdf-covers/'+encodeURIComponent(row.current.kind),{cover_pdf:action.cover_pdf,cover_pdf_name:action.cover_pdf_name,expected_version:action.expected_version}));
      if(saved.kind!==row.current.kind)throw new Error('The saved cover-sheet settings are invalid.');
      row.current=saved;row.draft=undefined;row.name=saved.cover_pdf_name;row.pending=null;row.conflicted=false;row.revision++;
      message(row.notice,saved.has_cover?'Cover sheet saved.':'Cover sheet removed.');
      return true;
    }catch(error){
      if(error.status&&!error.uncertain)row.pending=null;
      if(error.status===409)row.conflicted=true;
      message(row.notice,row.pending?'The cover sheet result could not be confirmed. Retry the same button to recover it.':error.status===409?'Cover sheet changed in another window. Your changes are kept. Retry to review and apply them.':error.message,true);
      return false;
    }finally{row.busy=false;render(row);endActivity?.();}
  }
  async function saveAll(){
    if(state.saving||state.opening||[...state.rows.values()].some(row=>row.reading||row.busy))throw new Error('Finish the cover-sheet upload before saving.');
    state.saving=true;for(const row of state.rows.values())render(row);
    try{
      for(const row of state.rows.values()){
        if(!changed(row)&&!row.pending)continue;
        if(!await perform(row,row.pending?.operation||(row.draft===null?'remove':'save')))throw new Error('Cover sheets were not all saved. Your remaining changes are kept. Click the main Save button to retry.');
      }
    }finally{state.saving=false;for(const row of state.rows.values())render(row);}
  }
  async function leave(){
    if(![...state.rows.values()].some(changed))return true;
    if(!await window.CeasefireDialogs.confirm('Unsaved changes','Discard unsaved cover-sheet changes?','Yes','Cancel'))return false;
    for(const row of state.rows.values()){
      row.draft=undefined;row.name=row.current.cover_pdf_name;row.conflicted=false;row.revision++;text(row.notice,'');render(row);
    }
    return true;
  }
  const kinds = {
    'certification':'certification', 'estimate.summary.pdf':'estimate', 'project.full_schedule.pdf':'full_schedule',
    'project.full_product_summary.pdf':'full_product_summary','firestopping.schedule.pdf':'firestopping_schedule',
    'calculator.steel_vermiculite.schedule.pdf':'steel_vermiculite_schedule','calculator.steel_intumescent.schedule.pdf':'steel_intumescent_schedule',
    'calculator.steel_board.schedule.pdf':'steel_board_schedule','calculator.ductwork.schedule.pdf':'ductwork_schedule',
    'calculator.steel_vermiculite.product_summary.pdf':'steel_vermiculite_product_summary',
    'calculator.steel_intumescent.product_summary.pdf':'steel_intumescent_product_summary',
    'calculator.steel_board.product_summary.pdf':'steel_board_product_summary',
    'calculator.ductwork.product_summary.pdf':'ductwork_product_summary',
    'swms':'swms','commercial.quote':'quote','commercial.work_order':'work_order',
    'commercial.purchase_order':'purchase_order','takeoff.markups.pdf':'takeoff_markups'
  };
  function attach(tr, documentKind) {
    const kind=kinds[documentKind], row=state.rows.get(kind);
    if(kind)tr.dataset.coverKind=kind;
    for(const existing of tr.querySelectorAll('.document-cover-file,.document-cover-actions'))existing.remove();
    if(row)tr.append(row.fileCell,row.actionCell);
    else {
      const file=node('td'), actions=node('td');
      file.className='document-cover-file'; actions.className='document-cover-actions';tr.append(file,actions);
    }
  }
  async function open(){
    if(state.opening)return state.opening;
    if(state.loaded)return;
    state.opening=(async()=>{
      message(status,'Loading cover sheets…');host.setAttribute('aria-busy','true');
      const result=await request('/api/pdf-covers');
      if(!Array.isArray(result.items)||result.items.length>64)throw new Error('The saved cover-sheet settings are invalid.');
      const items=result.items.map(validate),kinds=new Set(items.map(item=>item.kind));
      if(kinds.size!==items.length)throw new Error('The saved cover-sheet settings are invalid.');
      state.rows=new Map(items.map(item=>[item.kind,createRow(item)]));for(const tr of host.querySelectorAll('tr[data-document-kind]'))attach(tr,tr.dataset.documentKind);state.loaded=true;text(status,'');
    })();
    const endActivity=window.CeasefireActivity?.begin();
    try{await state.opening;}
    catch(error){message(status,'Cover sheets could not be loaded. Open Documentation again to retry.',true);}
    finally{state.opening=null;host.setAttribute('aria-busy','false');endActivity?.();}
  }
  window.CeasefireCoverSheets={open,attach,saveAll,leave,hasPendingOperation:()=>state.saving||!!state.opening||[...state.rows.values()].some(row=>row.reading||row.busy||row.pending),
    hasUnsavedChanges:()=>[...state.rows.values()].some(changed),
    fingerprint:()=>JSON.stringify([...state.rows.values()].map(row=>({kind:row.current.kind,version:row.current.version,name:row.name,revision:row.revision,reading:row.reading,conflicted:row.conflicted,pending:row.pending&&{operation:row.pending.operation,version:row.pending.expected_version}})))};
})();
