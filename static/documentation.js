(() => {
  "use strict";
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const PDF = "application/pdf", XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const state = { epoch:0, scope:null, model:null, baseline:0, opening:null, catalog:null, catalogLoading:null,
    refreshRevision:0, action:null, uncertain:false, pending:new Map(), sources:new Map() };
  const captures = new WeakMap();
  function text(element, value, args = []) {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element,value,args);
    element.textContent=String(value).replace(/\{(\d+)\}/g,(match,index)=>args[index] ?? match); return element;
  }
  function node(tag, className, value, args) {
    const element=document.createElement(tag); if(className)element.className=className;
    if(value!==undefined)text(element,value,args); return element;
  }
  function status(value,error=false,args=[]) { const host=$("documentation-status"); if(!host)return;
    text(host,value,args);host.classList.toggle("error",error); }
  async function request(path) {
    const response=await fetch(path), value=await response.json();
    if(!response.ok)throw new Error(value?.error||"Project documents could not be loaded.");return value;
  }
  function current(scope,epoch=state.epoch) {
    return epoch===state.epoch && state.scope?.workspace_id===scope.workspace_id && state.scope?.project_id===scope.project_id
      && window.CeasefireCertification?.sessionId?.()===scope.workspace_id;
  }
  function checkedScope(value) {
    if(!value||!UUID.test(value.workspace_id)||!UUID.test(value.project_id))throw new Error("The current project document workspace is invalid.");
    return {workspace_id:value.workspace_id,project_id:value.project_id};
  }
  function checkedModel(value,scope) {
    if(!value||value.workspace_id!==scope.workspace_id||value.project_id!==scope.project_id||!Number.isSafeInteger(value.workspace_revision)
      ||value.workspace_revision<0||!Array.isArray(value.items)||value.items.length>2000)throw new Error("The project document history does not match the current project.");
    const seen=new Set();
    for(const item of value.items) {
      if(!item||!UUID.test(item.id)||seen.has(item.id)||typeof item.kind!=="string"||item.kind.length>100||typeof item.label!=="string"
        ||item.label.length>200||typeof item.filename!=="string"||item.filename.length>255||!Number.isSafeInteger(item.revision)||item.revision<1
        ||![PDF,XLSX].includes(item.media_type)||item.url!==`/api/documentation/${item.id}?workspace=${scope.workspace_id}`)
        throw new Error("A project document revision has an invalid identity or link.");
      seen.add(item.id);
    }
    return copy(value);
  }
  async function catalog() {
    if(state.catalog)return state.catalog;
    if(!state.catalogLoading)state.catalogLoading=request('/api/documentation/catalog').then(value=>{
      if(!Array.isArray(value.documents)||value.documents.length>100)throw new Error("The document download list is invalid.");
      const seen=new Set();
      for(const row of value.documents) {
        if(!row||typeof row.id!=="string"||!row.id||seen.has(row.id)||!["pdf","xlsx"].includes(row.format)
          ||typeof row.label!=="string"||!["estimate","calculator","firestopping","pricing","certification","library","takeoff"].includes(row.adapter)
          ||!row.spec||typeof row.spec!=="object")throw new Error("The document download list is invalid.");
        seen.add(row.id);
      }
      state.catalog=copy(value.documents);return state.catalog;
    }).finally(()=>{state.catalogLoading=null;});
    return state.catalogLoading;
  }
  async function ensureWorkspace() {
    if(state.scope&&state.model&&current(state.scope))return state.scope;
    if(state.opening)return state.opening;
    const epoch=state.epoch;
    const task=(async()=>{
      const scope=checkedScope(await window.CeasefireCertification.projectWorkspace());
      if(epoch!==state.epoch)throw new Error("The project changed while loading its documents. Open Documentation again.");
      const model=checkedModel(await request(`/api/documentation?workspace=${scope.workspace_id}`),scope);
      if(epoch!==state.epoch||window.CeasefireCertification.sessionId()!==scope.workspace_id)
        throw new Error("The project changed while loading its documents. Open Documentation again.");
      state.scope=scope;state.model=model;state.baseline=model.workspace_revision;return scope;
    })();
    state.opening=task;
    try{return await task;}finally{if(state.opening===task)state.opening=null;}
  }
  async function refresh(scope=state.scope) {
    if(!scope||!current(scope))return;
    const epoch=state.epoch, revision=++state.refreshRevision;
    const model=checkedModel(await request(`/api/documentation?workspace=${scope.workspace_id}`),scope);
    if(!current(scope,epoch)||revision!==state.refreshRevision)return;
    state.model=model;state.uncertain=false;render();window.CeasefireProject?.changed?.();
    return model;
  }
  function render() {
    if(!state.catalog)return;
    const rows=[...state.catalog], known=new Set(rows.map(row=>row.id));
    for(const item of state.model?.items||[])if(!known.has(item.kind)) {
      known.add(item.kind);rows.push({id:item.kind,label:item.label,format:item.media_type===PDF?'pdf':'xlsx',historyOnly:true});
    }
    for(const format of ['pdf','xlsx']) {
      const host=$("documentation-"+format+"-rows");if(!host)continue;
      host.replaceChildren(...rows.filter(row=>row.format===format).map(row=>{
        const tr=node('tr'), action=node('td'), history=node('td'), controls=node('div','documentation-download');
        tr.dataset.documentKind=row.id;
        const button=node('button','button secondary',row.label);button.type='button';button.dataset.documentKind=row.id;
        button.disabled=!!state.action||row.historyOnly;button.addEventListener('click',()=>run(row,button));controls.append(button);
        if(row.adapter==='firestopping'&&row.spec.scope==='current_item') {
          const select=node('select');
          if(window.CeasefireI18n)window.CeasefireI18n.attr(select,'aria-label',"Document source");
          else select.setAttribute('aria-label',"Document source");
          for(const [value,label] of [['current','Current item'],['library','Firestopping Library item']]) {
            const option=node('option','',label);option.value=value;select.append(option);
          }
          select.value=state.sources.get(row.id)||'current';select.addEventListener('change',()=>state.sources.set(row.id,select.value));controls.append(select);
        }
        action.append(controls);
        if(row.historyOnly)action.append(node('p','helper',"This download is not available in this edition."));
        const items=(state.model?.items||[]).filter(item=>item.kind===row.id);
        if(!items.length)history.append(node('p','documentation-empty',"No revisions generated in this project."));
        else {
          const list=node('ul','documentation-revisions');
          for(const item of items) {
            const line=node('li','documentation-revision'), link=node('a','',"Revision {0}",[item.revision]);
            link.href=item.url;link.target='_blank';link.rel='noopener';link.title=item.filename;
            const name=node('small');name.textContent=item.filename;line.append(link,name);
            const date=new Date(item.created_at);
            if(!Number.isNaN(date.getTime())) { const time=node('time');time.dateTime=date.toISOString();time.textContent=date.toLocaleString('en-AU');line.append(time); }
            list.append(line);
          }
          history.append(list);
        }
        tr.append(action,history);return tr;
      }));
    }
  }
  async function run(row,button) {
    if(state.action||hasPendingOperation())return;
    const scope=await ensureWorkspace(),epoch=state.epoch;
    if(state.action||state.pending.size||!current(scope,epoch))return;
    state.action=row.id;button.setAttribute('aria-busy','true');status("Preparing document…");
    try {
      const spec=copy(row.spec);let result;
      if(row.adapter==='calculator')result=await window.CeasefireCalculators.documentationExport(spec,button);
      else if(row.adapter==='firestopping')result=spec.scope==='current_item'&&state.sources.get(row.id)==='library'
        ?await window.CeasefireLibraryEditor.documentationExport({format:spec.format},button)
        :await window.CeasefirePenetrations.documentationExport(spec,button);
      else if(row.adapter==='takeoff')result=await window.CeasefireTakeoffs.documentationExport(spec,button);
      else if(row.adapter==='library')result=await window.CeasefireLibraries.documentationExport(spec,button);
      else result=await window.CeasefireDocumentationApp.run(row.adapter,spec,button);
      if(!current(scope,epoch))return;
      await refresh(scope);
      if(result?.selectionRequired)status("Complete the document options in the selected workspace, then generate the file.");
      else if(result?.saved)status("Document saved. Its revision is available in this project.");
      else status("");
    } catch(error) {if(current(scope,epoch))status(error.message,true);}
    finally {if(epoch===state.epoch){state.action=null;button.removeAttribute('aria-busy');render();}}
  }
  async function open() {await catalog();await ensureWorkspace();await refresh();render();}
  async function prepareProject(manifest,workspaceId) {
    if(!workspaceId) return null;
    if(!UUID.test(workspaceId))throw new Error("The current project document workspace is invalid.");
    const value=await request(`/api/documentation?workspace=${workspaceId}`),scope=checkedScope(value),model=checkedModel(value,scope);
    if(manifest&&(manifest.project_id!==scope.project_id||manifest.revision_count!==model.workspace_revision))
      throw new Error("The saved document history does not match this project.");
    return {scope,model};
  }
  function applyProject(prepared) {
    state.epoch++;state.scope=prepared?checkedScope(prepared.scope):null;
    state.model=prepared?checkedModel(prepared.model,state.scope):null;
    state.baseline=state.model?.workspace_revision||0;state.opening=null;state.refreshRevision++;
    state.action=null;state.uncertain=false;state.sources.clear();status("");render();
  }
  function projectFingerprint() {return JSON.stringify({project_id:state.scope?.project_id||null,revision:state.model?.workspace_revision||0,uncertain:state.uncertain});}
  async function completeProjectSnapshot() {
    if(hasPendingOperation())throw new Error("Finish the current document download before saving the project.");
    const scope=await ensureWorkspace();await refresh(scope);
    const snapshot={workspace_id:scope.workspace_id,expected_revision:state.model.workspace_revision};
    captures.set(snapshot,projectFingerprint());return snapshot;
  }
  function markProjectSaved(manifest,captured) {
    if(!state.uncertain&&manifest?.project_id===state.scope?.project_id&&captures.get(captured)===projectFingerprint()
      &&manifest.revision_count===state.model?.workspace_revision)state.baseline=state.model.workspace_revision;
  }
  function hasPendingOperation() {return !!state.action||!!state.opening||state.pending.size>0;}
  function supported(path) {
    return /^\/api\/(?:quote-report|quotes\/[^/]+\/report\.pdf|pricing\/export|project\/(?:full-schedule|full-product-summary)\.pdf)$/.test(path)
      ||/^\/api\/calculators\/(?:steel_vermiculite|steel_intumescent|steel_board|ductwork)\/(?:report\.pdf|summary\.pdf|register\.xlsx|template)$/.test(path)
      ||/^\/api\/(?:technical\/item\.(?:pdf|xlsx)|penetration\/(?:item\.(?:pdf|xlsx)|report\.pdf|register\.xlsx))$/.test(path)
      ||/^\/api\/takeoffs\/sessions\/[a-z0-9-]+\/(?:physical\/export\/(?:pdf|xlsx|register-xlsx)|export\/(?:xlsx|register-xlsx|schedule-xlsx|markup-pdf|marked-pdf)|pdf-tools)$/.test(path);
  }
  async function downloadHeaders(path) {
    if(!supported(path))return {};
    const epoch=state.epoch,scope=await ensureWorkspace();
    if(!current(scope,epoch))throw new Error("The project changed while preparing the document.");
    const id=crypto.randomUUID();state.pending.set(id,{scope,epoch});
    return {'X-Estimator-Documentation-Workspace':scope.workspace_id,'X-Estimator-Documentation-Request':id};
  }
  async function downloadCompleted(headers,result) {
    const id=headers?.['X-Estimator-Documentation-Request'],pending=state.pending.get(id);
    if(!pending)return;
    try {
      if(current(pending.scope,pending.epoch))await refresh(pending.scope);
    } catch(error) {
      if(current(pending.scope,pending.epoch)){state.uncertain=true;status(error.message,true);window.CeasefireProject?.changed?.();}
    } finally {state.pending.delete(id);}
  }
  window.addEventListener('ceasefire:certification-revision-saved',event=>{
    if(state.scope&&event.detail?.workspace_id===state.scope.workspace_id&&event.detail?.project_id===state.scope.project_id)
      void refresh(state.scope).catch(error=>status(error.message,true));
  });
  window.CeasefireDocumentation={open,prepareProject,applyProject,completeProjectSnapshot,markProjectSaved,projectFingerprint,
    hasProjectChanges:()=>state.uncertain||!!state.model&&state.model.workspace_revision!==state.baseline,hasPendingOperation,downloadHeaders,downloadCompleted};
})();
