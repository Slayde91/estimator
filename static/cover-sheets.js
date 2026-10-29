(() => {
  'use strict';
  const host=document.getElementById('cover-sheets-rows');
  if(!host)return;
  const status=document.getElementById('cover-sheets-status'),state={rows:new Map(),loaded:false,opening:null};
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
  function message(element,source,error=false){text(element,source);element.className=error?'message error':'helper';}
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
  // Saved rows contain metadata only. Large PDF data stays in a row solely
  // while its explicitly selected upload is awaiting Save or a safe retry.
  const changed=row=>row.conflicted||row.draft!==undefined;
  function render(row){
    const present=row.draft===undefined?row.current.has_cover:!!row.draft;
    text(row.filename,present?'Cover sheet: {0}':'No cover sheet selected.',present?[row.name||'Cover sheet.pdf']:[]);
    row.file.disabled=row.reading||row.busy||!!row.pending;
    row.save.disabled=row.reading||row.busy||!!row.pending&&row.pending.operation!=='save'||!row.pending&&!row.draft;
    row.remove.disabled=row.reading||row.busy||!!row.pending&&row.pending.operation!=='remove'||!row.pending&&!row.current.has_cover&&!row.draft&&!row.conflicted;
    row.element.setAttribute('aria-busy',String(row.reading||row.busy));
  }
  function createRow(item){
    const element=node('tr'),label=node('th'),fileCell=node('td'),actionCell=node('td'),file=node('input'),filename=node('p'),notice=node('p'),actions=node('div'),save=node('button'),remove=node('button');
    element.setAttribute('data-cover-kind',item.kind);label.scope='row';text(label,item.label);
    file.type='file';file.accept='.pdf,application/pdf';file.id='cover-sheet-'+item.kind;
    attr(file,'aria-label','PDF cover sheet for {0}',[term(item.label)]);
    filename.className='helper';notice.className='helper';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
    save.type=remove.type='button';save.className='button secondary';remove.className='button secondary icon-only';actions.className='cover-sheet-actions';
    text(save,'Save');attr(save,'aria-label','Save cover sheet for {0}',[term(item.label)]);
    attr(remove,'aria-label','Delete cover sheet for {0}',[term(item.label)]);attr(remove,'title','Delete cover sheet for {0}',[term(item.label)]);
    // Constant application artwork, never user-supplied markup.
    remove.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"></path></svg>';
    fileCell.append(file,filename,notice);actions.append(save,remove);actionCell.append(actions);element.append(label,fileCell,actionCell);
    const row={current:item,draft:undefined,name:item.cover_pdf_name,revision:0,reading:false,busy:false,pending:null,conflicted:false,element,file,filename,notice,save,remove};
    file.addEventListener('change',()=>upload(row));save.addEventListener('click',()=>perform(row,'save'));remove.addEventListener('click',()=>perform(row,'remove'));render(row);return row;
  }
  async function upload(row){
    const file=row.file.files?.[0];if(!file||row.reading||row.busy||row.pending)return;
    if((!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')||!file.size||file.size>10*1024*1024||file.name.length>200||/[\/\\\x00-\x1f]/.test(file.name)){
      message(row.notice,'Choose a PDF cover sheet smaller than 10 MB.',true);row.file.value='';return;
    }
    row.reading=true;render(row);const endActivity=window.CeasefireActivity?.begin();
    try{
      const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('The PDF cover sheet could not be read.'));reader.readAsDataURL(file);});
      const next='data:application/pdf;base64,'+String(value).split(',')[1];
      if(!/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(next))throw new Error('The PDF cover sheet could not be read.');
      row.draft=next;row.name=file.name;row.revision++;message(row.notice,'Unsaved changes');
    }catch(error){message(row.notice,error.message,true);}
    finally{row.reading=false;row.file.value='';render(row);endActivity?.();}
  }
  async function perform(row,operation){
    if(row.reading||row.busy||row.pending&&row.pending.operation!==operation||operation==='save'&&!row.pending&&!row.draft)return;
    const endActivity=window.CeasefireActivity?.begin();row.busy=true;render(row);
    try{
      if(row.conflicted&&!row.pending){
        const accepted=await window.CeasefireDialogs.confirm('Cover sheet changed','This cover sheet was changed in another window. Apply your cover-sheet change?','Apply cover-sheet change','Keep editing');
        if(!accepted)return;
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
    }catch(error){
      if(error.status&&!error.uncertain)row.pending=null;
      if(error.status===409)row.conflicted=true;
      message(row.notice,row.pending?'The cover sheet result could not be confirmed. Retry the same button to recover it.':error.status===409?'Cover sheet changed in another window. Your changes are kept. Retry to review and apply them.':error.message,true);
    }finally{row.busy=false;render(row);endActivity?.();}
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
      state.rows=new Map(items.map(item=>[item.kind,createRow(item)]));host.replaceChildren(...[...state.rows.values()].map(row=>row.element));state.loaded=true;text(status,'');
    })();
    const endActivity=window.CeasefireActivity?.begin();
    try{await state.opening;}
    catch(error){message(status,'Cover sheets could not be loaded. Open Settings again to retry.',true);}
    finally{state.opening=null;host.setAttribute('aria-busy','false');endActivity?.();}
  }
  window.CeasefireCoverSheets={open,hasPendingOperation:()=>!!state.opening||[...state.rows.values()].some(row=>row.reading||row.busy||row.pending),
    hasUnsavedChanges:()=>[...state.rows.values()].some(changed),
    fingerprint:()=>JSON.stringify([...state.rows.values()].map(row=>({kind:row.current.kind,version:row.current.version,name:row.name,revision:row.revision,reading:row.reading,conflicted:row.conflicted,pending:row.pending&&{operation:row.pending.operation,version:row.pending.expected_version}})))};
})();
