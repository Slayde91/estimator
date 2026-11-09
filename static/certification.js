(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('certification-form');
  if (!form) return;
  const fieldNames = ['client', 'project', 'address', 'location_area', 'statement_of_compliance',
    'australian_standards', 'ncc_clauses', 'approved_design', 'additional_standards',
    'other_references', 'exclusions', 'materials_manufacturers', 'fire_resistance_level',
    'name', 'position', 'qualification', 'accreditation'];
  const signerNames = ['name', 'position', 'qualification', 'accreditation'];
  const requiredNames = fieldNames.filter(name => !['qualification','accreditation'].includes(name));
  const meaningful = value => Boolean(value.replace(/\p{Cf}/gu, '').trim());
  const controls = Object.fromEntries(fieldNames.map(name => [name, $('certification-' + name)]));
  const selector = $('certification-document'), saveButton = $('certification-save') || $('certification-save-draft'), generateButton = $('certification-generate');
  const workflow = $('certification-workflow');
  const newButton = $('certification-new');
  const signatureButton = $('certification-signature-use');
  const statement = "This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule.\n\nAll materials have been installed at the above location and comply with:";
  // These are the user's exact editable presets, not a determination of compliance.
  const as1530 = 'AS 1530.4: 2014 Methods for fire tests on building materials, components & structures';
  const c2d9 = 'BCA 2022: C2D9 Lightweight Construction';
  const scopes = [
    {id:'structural_steel', label:'Structural steel', as:[as1530], ncc:[c2d9]},
    {id:'structural_steel_columns', label:'Structural steel incl. columns', as:[as1530], ncc:[c2d9, 'BCA 2022: C4D17 Columns protected with lightweight construction to achieve an FRL']},
    {id:'ductwork', label:'Ductwork', as:[as1530], ncc:[c2d9]},
    {id:'service_penetrations', label:'Service penetrations', as:[as1530, 'AS 4072.1: 2005 Protection of openings in fire-resistant separating elements'], ncc:[
      'BCA 2022: Specification 13, Penetration of walls, floors and ceilings by services',
      'BCA 2022: C4D13 Openings in floors and ceilings for services',
      'BCA 2022: C4D15 Openings for service installations',
      'BCA 2022: C4D16 Construction joints']}
  ];
  const scopeControls = scopes.map(scope => $('certification-scope-' + scope.id));
  const emptyOptions = () => ({cover_pdf:null, cover_pdf_name:'', scopes:[],signature_image:null,signature_name:''});
  const state = {id:null, version:null, baseline:null, busy:false, pending:null, loaded:false,
    items:[], listRevision:0, companyName:'', opening:null, conflicted:false,
    workspaceId:null, projectId:null, workspaceOpening:null, workspaceEpoch:0, projectBaseline:null,
    options:emptyOptions(), signatureRevision:0, readingSignature:false, touched:new Set(),
    managed:{australian_standards:[], ncc_clauses:[]}, managedByDocument:new Map()};
  const fields = () => Object.fromEntries(fieldNames.map(name => [name, controls[name].value]));
  const options = () => ({...state.options, scopes:[...state.options.scopes]});
  const snapshot = () => ({fields:fields(), options:options()});
  const smallStamp = value => JSON.stringify(value);
  const equal = (a,b) => smallStamp(a) === smallStamp(b);
  state.baseline = snapshot();
  function text(element, source, args = []) {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = source.replace(/\{(\d+)\}/g, (_, n) => typeof args[n]==='function'?args[n]():args[n]??''); return element;
  }
  function node(tag, value) { const item = document.createElement(tag); if (value !== undefined) item.textContent = String(value); return item; }
  function message(source, error = false) {
    text($('certification-status'), source);
    $('certification-status').className = error ? 'message error certification-save-status' : 'helper certification-save-status';
    window.CeasefireNotifications?.show($('certification-status'));
  }
  function dirty() {
    return state.conflicted || !equal(fields(),state.baseline.fields) ||
      state.options.cover_pdf !== state.baseline.options.cover_pdf || state.options.cover_pdf_name !== state.baseline.options.cover_pdf_name ||
      state.options.signature_image !== state.baseline.options.signature_image || state.options.signature_name !== state.baseline.options.signature_name ||
      state.options.workflow_status !== state.baseline.options.workflow_status ||
      !equal(state.options.scopes,state.baseline.options.scopes);
  }
  function updateControls() {
    const locked = !state.loaded || !!state.opening || state.busy || !!state.pending || state.readingSignature;
    for (const control of [...Object.values(controls), ...scopeControls]) control.disabled = locked;
    selector.disabled = locked || !state.items.length;
    if(newButton)newButton.disabled=locked;
    if(workflow){workflow.value=state.options.workflow_status || 'Draft';workflow.disabled=locked;}
    signatureButton.disabled = locked;
    $('certification-signature-clear').disabled = locked || (!state.options.signature_image && !signerNames.some(name=>controls[name].value));
    if(saveButton)saveButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingSignature || (!!state.pending && state.pending.kind !== 'save');
    generateButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingSignature || (!!state.pending && state.pending.kind !== 'generate');
    form.setAttribute('aria-busy', String(state.busy || !!state.opening || state.readingSignature));
  }
  function companyText(name) {
    state.companyName = name;
    text($('certification-exclusions-intro'),
      'Certification is strictly limited to works completed by {0}, as per:', [name]);
    text($('certification-declaration'),
      '{0} are approved by the manufacturers listed above to supply and install passive fire products in accordance with tested and certified systems. I am a properly qualified person and have a good working knowledge of the relevant codes and standards referenced above. The information contained in this statement is true and accurate to the best of my knowledge.', [name]);
  }
  async function request(path, opts = {}) {
    const response = await fetch(path, opts); let result;
    try { result = await response.json(); }
    catch { const error = new Error('The operation result could not be confirmed. Retry the same operation.'); error.uncertain = true; throw error; }
    if (!response.ok) {
      const error = new Error(result.error || 'Certification details could not be saved.');
      error.status = response.status; error.uncertain = response.status >= 500; throw error;
    }
    return result;
  }
  const post = (path, body) => request(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const scoped = (path,workspace=state.workspaceId) => {
    if(!workspace)throw new Error('The current project certificate workspace is unavailable.');
    return path+'?workspace='+encodeURIComponent(workspace);
  };
  const uuid = () => window.crypto.randomUUID();
  async function personalDetails() {
    const saved=await request('/api/certifications/defaults');
    if(!saved?.fields || signerNames.some(name=>typeof saved.fields[name]!=='string')) throw new Error('Personal details could not be loaded. Try again.');
    return saved.fields;
  }
  function label(item) {
    const value=item.fields||item;
    return [item.reference,value.project,value.client,value.address].filter(Boolean).join(' · ') || 'Certificate '+item.id.slice(0,8);
  }
  function renderDocuments() {
    const saved=state.items.map(item=>{const option=node('option',label(item));option.value=item.id;return option;});
    selector.replaceChildren(...saved);selector.value=state.id||'';
    const board=$('certification-board');
    if (board && window.ClassifireDocumentBoard) window.ClassifireDocumentBoard.render(board,{
      items:state.items, stageOf:item=>item.options?.workflow_status || item.workflow_status || 'Draft',
      locked:()=>!state.loaded || state.busy || !!state.pending || !!state.opening || state.readingSignature || dirty(),
      move:moveCertificate, onError:error=>message(error.message,true),
      cardFor:item=>{
        const card=node('article'), heading=node('h3'), title=node('button',label(item));
        card.className='project-kanban-card'; title.className='text-button project-title-button';title.type='button';
        title.addEventListener('click',async()=>{await loadDocument(item.id);if(state.id===item.id)selector.focus();});
        heading.append(title);card.append(heading);
        const revisions=node('p');text(revisions,'{0} ({1})',[window.CeasefireI18n?.term('Certificate revisions') || 'Certificate revisions',item.revision_count ?? item.revisions?.length ?? 0]);card.append(revisions);
        return card;
      }
    });
  }
  async function moveCertificate(item, status) {
    if (state.busy || state.pending || state.opening || state.readingSignature || dirty()) return;
    const token=state.workspaceId, route=scoped('/api/certifications/'+encodeURIComponent(item.id),token);
    state.busy=true;updateControls();
    try {
      const current=await request(route);
      if (state.workspaceId!==token) return;
      if (current.version!==item.version) {await loadList();throw new Error('This certification changed in another window. Reload it before saving again.');}
      const saved=await post(route,{expected_version:item.version,fields:current.fields,options:{...current.options,workflow_status:status}});
      if (state.workspaceId!==token) return;
      if (state.id===saved.id) applyDocument(saved,{preserveManaged:true});
      else {state.items=state.items.map(row=>row.id===saved.id?saved:row);renderDocuments();}
      message('Certification details saved.');
      window.CeasefireProject?.changed?.();
    } catch(error){message(error.message,true);}
    finally {state.busy=false;updateControls();}
  }
  function renderSignature() {
    const preview=$('certification-signature-preview');
    preview.hidden=!state.options.signature_image;
    if(state.options.signature_image)preview.src=state.options.signature_image;
    else preview.removeAttribute('src');
  }
  signatureButton.addEventListener('click', async()=>{
    if(signatureButton.disabled)return;
    const stamp=state.signatureRevision, workspaceId=state.workspaceId, before=fields();
    state.readingSignature=true;updateControls();
    try {
      // An existing certificate image remains valid until the user applies a replacement.
      const signature=await window.ClassifirePersonalSignature.choose(Boolean(state.options.signature_image));
      if(!signature || stamp!==state.signatureRevision || workspaceId!==state.workspaceId)return;
      const saved=await personalDetails();
      if(stamp!==state.signatureRevision || workspaceId!==state.workspaceId)return;
      const image=window.ClassifirePersonalSignature.png(signature);
      for(const name of signerNames)if(!controls[name].value.trim() && controls[name].value===before[name]) {
        controls[name].value=saved[name];controls[name].setCustomValidity('');state.touched.add(name);
      }
      state.options.signature_image=image;
      state.options.signature_name='Personal signature.png';
      state.signatureRevision++;
      renderSignature();message('Unsaved certification details');
    }catch(error){if(stamp===state.signatureRevision && workspaceId===state.workspaceId)message(error.message,true);}
    finally{state.readingSignature=false;updateControls();}
  });
  $('certification-signature-clear').addEventListener('click',()=>{
    if($('certification-signature-clear').disabled)return;
    state.options.signature_image=null;state.options.signature_name='';state.signatureRevision++;
    for(const name of signerNames){controls[name].value='';controls[name].setCustomValidity('');state.touched.add(name);}
    renderSignature();updateControls();message('Unsaved certification details');
  });
  function presetLines(selected,key) {return [...new Set(scopes.filter(scope=>selected.includes(scope.id)).flatMap(scope=>scope[key]))];}
  function renderScopes() {
    scopeControls.forEach((control,index)=>{control.checked=state.options.scopes.includes(scopes[index].id);});
    // A live argument keeps the selected summary correct when language refresh
    // re-applies bindings; a stale "Choose…" binding must not replace it.
    text($('certification-scopes-summary'),'{0}',[()=>{
      const selected=scopes.filter(scope=>state.options.scopes.includes(scope.id));
      return selected.length?selected.map(scope=>window.CeasefireI18n?.translate?.(scope.label)||scope.label).join(', '):window.CeasefireI18n?.translate?.('Choose…')||'Choose…';
    }]);
  }
  function scopeChange() {
    const selected=scopes.filter((scope,index)=>scopeControls[index].checked).map(scope=>scope.id);
    for(const [name,key]of [['australian_standards','as'],['ncc_clauses','ncc']]){
      const manual=controls[name].value.split(/\r?\n/).filter(line=>!state.managed[name].includes(line));
      const manualValues=new Set(manual.map(line=>line.trim()).filter(Boolean)),next=presetLines(selected,key);
      state.managed[name]=next.filter(line=>!manualValues.has(line));
      const authored=manual.join('\n'),added=state.managed[name].join('\n');
      controls[name].value=added+(added&&authored?'\n':'')+authored;
    }
    state.options.scopes=selected;renderScopes();message(dirty()?'Unsaved certification details':'Saved certification details');
  }
  function renderRevisions(revisions) {
    const host=$('certification-revisions');
    if(!revisions.length){const empty=node('p');text(empty,'No certificates have been generated yet.');host.replaceChildren(empty);return;}
    const table=node('table'),head=node('thead'),headings=node('tr'),body=node('tbody');
    for(const source of ['Revision','Generated','Certificate']){const cell=node('th');cell.scope='col';text(cell,source);headings.append(cell);}head.append(headings);
    for(const revision of [...revisions].sort((a,b)=>b.revision-a.revision)){
      const row=node('tr'),number=node('td',revision.revision),date=new Date(revision.created_at);
      const when=node('td',Number.isNaN(date.getTime())?revision.created_at:date.toLocaleString('en-AU')),cell=node('td'),link=node('a');
      const expected=scoped('/api/certifications/'+encodeURIComponent(state.id)+'/revisions/'+revision.revision+'.pdf');
      if(!Number.isInteger(revision.revision)||revision.revision<1||revision.pdf_url!==expected)throw new Error('The saved certificate link is invalid.');
      // Revisions already exist: open their scoped immutable PDF without a save prerequisite.
      link.href=expected;link.target='_blank';link.rel='noopener';text(link,'Open revision {0}',[revision.revision]);cell.append(link);row.append(number,when,cell);body.append(row);
    }
    table.append(head,body);host.replaceChildren(table);
  }
  function normalizeOptions(value) {
    const result={...emptyOptions(),...(value||{})};
    if ('workflow_status' in result && !['Draft','Review','Approved','Rejected'].includes(result.workflow_status)) throw new Error('Choose a valid workflow status.');
    if(!Array.isArray(result.scopes)||result.scopes.some(id=>!scopes.some(scope=>scope.id===id)))throw new Error('The saved certification scope is invalid.');
    result.scopes=scopes.filter(scope=>result.scopes.includes(scope.id)).map(scope=>scope.id);
    if(typeof result.signature_name!=='string'||result.signature_name.length>200||/[\/\\\x00-\x1f]/.test(result.signature_name)||
      result.signature_image!==null&&(typeof result.signature_image!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(result.signature_image)))throw new Error('Choose a PNG or JPEG signature smaller than 2 MB.');
    return result;
  }
  function applyDocument(saved, {preserveManaged=false}={}) {
    clearFieldErrors();
    const cached=state.managedByDocument.get(saved.id);
    const known=preserveManaged?state.managed:cached?.version===saved.version?cached.managed:null;
    ++state.listRevision;state.id=saved.id;state.version=saved.version;state.conflicted=false;state.touched.clear();
    for(const name of fieldNames)controls[name].value=saved.fields[name]||'';
    state.options=normalizeOptions(saved.options);state.signatureRevision++;
    // Acknowledged local saves retain ownership. Unknown saved text is treated
    // as authored content, never silently deleted when a scope is cleared.
    state.managed=Object.fromEntries(['australian_standards','ncc_clauses'].map(name=>[name,
      (known?.[name]||[]).filter(line=>controls[name].value.split(/\r?\n/).includes(line))]));
    state.managedByDocument.set(saved.id,{version:saved.version,managed:{australian_standards:[...state.managed.australian_standards],ncc_clauses:[...state.managed.ncc_clauses]}});
    state.baseline=snapshot();
    const index=state.items.findIndex(item=>item.id===saved.id);
    if(index<0)state.items.unshift(saved);else state.items[index]=saved;
    renderDocuments();renderScopes();renderSignature();renderRevisions(saved.revisions||[]);
  }
  function acknowledgesAction(saved,action,version) {
    const savedOptions=normalizeOptions(saved.options);
    return saved.version===version && fieldNames.every(name=>saved.fields[name]===action.fields[name]) &&
      savedOptions.cover_pdf===action.options.cover_pdf && savedOptions.cover_pdf_name===action.options.cover_pdf_name &&
      savedOptions.signature_image===action.options.signature_image && savedOptions.signature_name===action.options.signature_name &&
      savedOptions.workflow_status===action.options.workflow_status &&
      equal(savedOptions.scopes,action.options.scopes);
  }
  function inheritedFields() {
    const project=window.CeasefireProject?.details?.()||{};
    return {client:project.client||'',project:project.project_no||'',address:project.site_address||'',
      exclusions:'Project No.: '+(project.project_no||''),statement_of_compliance:statement,
      approved_design:'N/A',additional_standards:'N/A',other_references:'N/A'};
  }
  function refreshInheritedFields() {
    if(state.id||!state.loaded||state.busy||state.pending||state.readingSignature)return;
    for(const [name,value]of Object.entries(inheritedFields()))if(!state.touched.has(name)){
      controls[name].value=value;state.baseline.fields[name]=value;
    }

  }
  async function confirmDiscard() {
    if(!dirty())return true;
    const captured=smallStamp(snapshot()),id=state.id;
    const accepted=await window.CeasefireDialogs.confirm('Unsaved certification details',
      'Continue without saving these certification details?','Continue without saving','Keep editing');
    if(!accepted)return false;
    if(captured!==smallStamp(snapshot())||id!==state.id||state.busy||state.pending||state.readingSignature){
      message('Certification details changed during the confirmation. Review the current fields first.',true);return false;
    }
    return true;
  }
  function freshFields() {
    clearFieldErrors();
    for(const name of fieldNames)controls[name].value='';
    Object.entries(inheritedFields()).forEach(([name,value])=>{controls[name].value=value;});
    state.id=state.version=null;state.conflicted=false;state.touched.clear();
    state.options=emptyOptions();state.signatureRevision++;
    state.managed={australian_standards:[],ncc_clauses:[]};state.baseline=snapshot();
    renderDocuments();renderScopes();renderSignature();renderRevisions([]);updateControls();message('Enter the certification details.');
  }
  async function loadDocument(id) {
    if(!id && !window.CeasefireProject?.requireCreatedProject?.()){selector.value=state.id||'';return;}
    if(state.busy||state.pending||state.opening||state.readingSignature||!await confirmDiscard()){selector.value=state.id||'';return;}
    if(state.busy||state.pending||state.opening||state.readingSignature){selector.value=state.id||'';return;}
    state.busy=true;updateControls();
    try{
      if(!id){freshFields();return;}
      message('Loading certification…');applyDocument(await request(scoped('/api/certifications/'+encodeURIComponent(id))));message('Saved certification details');
    }catch(error){selector.value=state.id||'';message(error.message,true);}
    finally{state.busy=false;updateControls();if(!id)controls.client.focus?.();}
  }
  async function loadList() {
    const revision=++state.listRevision,data=await request(scoped('/api/certifications'));
    if(revision!==state.listRevision)return;state.items=data.items||[];renderDocuments();
  }
  const projectCaptures=new WeakMap();
  function projectFingerprint() {
    return JSON.stringify({workspace_id:state.workspaceId,draft:{id:state.id,version:state.version,...snapshot()},
      documents:state.items.map(item=>({id:item.id,version:item.version,revision_count:item.revision_count??item.revisions?.length??0})).sort((a,b)=>a.id.localeCompare(b.id)),
      signature_revision:state.signatureRevision});
  }
  function workspaceIdentity(prepared) {
    const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!prepared||typeof prepared.workspace_id!=='string'||!identity.test(prepared.workspace_id)||
       typeof prepared.project_id!=='string'||!identity.test(prepared.project_id)||!Array.isArray(prepared.items))
      throw new Error('The current project certificate workspace is unavailable.');
    return {workspace_id:prepared.workspace_id,project_id:prepared.project_id};
  }
  async function ensureWorkspace() {
    if(state.workspaceId)return;
    if(!state.workspaceOpening){
      const epoch=state.workspaceEpoch;
      state.workspaceOpening=post('/api/certifications/workspaces',{}).then(prepared=>{
        workspaceIdentity(prepared);
        // A prepared project can be adopted while a capability-only caller is
        // waiting. Its older response must never replace the new project scope.
        if(epoch!==state.workspaceEpoch)throw new Error('The current project certificate workspace is unavailable.');
        state.workspaceId=prepared.workspace_id;state.projectId=prepared.project_id;state.items=prepared.items;
      });
    }
    const opening=state.workspaceOpening;
    try{
      await opening;
    }finally{if(state.workspaceOpening===opening)state.workspaceOpening=null;}
  }
  async function projectWorkspace() {
    await ensureWorkspace();
    return {workspace_id:state.workspaceId,project_id:state.projectId};
  }
  async function completeProjectSnapshot() {
    if(state.busy||state.pending||state.opening||state.workspaceOpening||state.readingSignature)throw new Error('Finish the current certificate operation before saving the project.');
    if(!state.loaded)await open();
    if(state.busy||state.pending||state.opening||state.readingSignature)throw new Error('Finish the current certificate operation before saving the project.');
    const capture={workspace_id:state.workspaceId,draft:{id:state.id,version:state.version,...snapshot()}};
    projectCaptures.set(capture,projectFingerprint());return capture;
  }
  async function prepareProject(manifest,workspaceId) {
    if(manifest&&!workspaceId)throw new Error('Load this saved project through Projects to restore its certificate evidence.');
    const prepared=workspaceId?await request('/api/certifications/workspaces/'+encodeURIComponent(workspaceId)):await post('/api/certifications/workspaces',{});
    workspaceIdentity(prepared);
    if(prepared.draft?.id)prepared.current=await request(scoped('/api/certifications/'+encodeURIComponent(prepared.draft.id),prepared.workspace_id));
    if(prepared.draft)normalizeOptions(prepared.draft.options);
    return prepared;
  }
  function applyProject(prepared) {
    if(state.busy||state.pending||state.opening)throw new Error('Finish the current certificate operation before changing projects.');
    workspaceIdentity(prepared);
    ++state.listRevision;++state.workspaceEpoch;state.workspaceId=prepared.workspace_id;state.projectId=prepared.project_id;
    state.items=prepared.items||[];state.id=state.version=null;state.conflicted=false;state.pending=null;state.managedByDocument.clear();state.loaded=true;
    freshFields();
    if(prepared.draft){
      const draft=prepared.draft;
      if(draft.id)applyDocument({...prepared.current,fields:draft.fields,options:draft.options});
      else{
        for(const name of fieldNames)controls[name].value=draft.fields[name]||'';
        state.options=normalizeOptions(draft.options);state.signatureRevision++;state.touched=new Set(fieldNames);
        renderSignature();renderScopes();renderRevisions([]);state.baseline=snapshot();
      }
    }
    state.projectBaseline=projectFingerprint();updateControls();
  }
  function markProjectSaved(manifest,captured) {
    if(projectCaptures.get(captured)===projectFingerprint()){
      state.projectBaseline=projectFingerprint();state.baseline=snapshot();state.conflicted=false;
      message('Saved certification details');
    }
  }
  async function discardPreparedSession(workspaceId) {
    if(workspaceId&&workspaceId!==state.workspaceId)await post('/api/certifications/workspaces/'+encodeURIComponent(workspaceId)+'/discard',{});
  }
  async function open() {
    if(state.opening)return state.opening;
    message('Loading certification…');
    state.opening=(async()=>{
      const company=await request('/api/company-settings');
      companyText(company.name);
      await ensureWorkspace();
      await loadList();
      if(!state.loaded){state.loaded=true;freshFields();state.projectBaseline=projectFingerprint();}
      else{refreshInheritedFields();renderSignature();message(dirty()?'Unsaved certification details':'Saved certification details');}
    })();updateControls();
    try{return await state.opening;}finally{state.opening=null;updateControls();}
  }
  async function perform(kind) {
    if(!state.loaded||state.opening||state.busy||state.readingSignature||(state.pending&&state.pending.kind!==kind))return;
    if(!state.id && !state.pending && !window.CeasefireProject?.requireCreatedProject?.())return;
    if(!state.pending && kind==='generate' && !validateGeneration())return;
    const action=state.pending||{kind,...snapshot(),id:state.id,version:state.version,workspaceId:state.workspaceId,createRequestId:uuid(),generationRequestId:uuid()};
    state.pending=action;state.busy=true;updateControls();
    message(kind==='generate'?'Generating and saving certificate revision…':'Saving certification details…');
    const endActivity=window.CeasefireActivity?.begin();
    try{
      if(!action.id){
        const created=await post(scoped('/api/certifications',action.workspaceId),{fields:action.fields,options:action.options,request_id:action.createRequestId});
        action.id=created.id;action.version=created.version;applyDocument(created,{preserveManaged:acknowledgesAction(created,action,1)});
        if(kind==='save'){state.pending=null;message('Certification details saved.');return;}
      }
      if(kind==='save'){
        const saved=await post(scoped('/api/certifications/'+encodeURIComponent(action.id),action.workspaceId),{fields:action.fields,options:action.options,expected_version:action.version});
        state.pending=null;applyDocument(saved,{preserveManaged:acknowledgesAction(saved,action,action.version+1)});message('Certification details saved.');
      }else{
        const saved=await post(scoped('/api/certifications/'+encodeURIComponent(action.id)+'/revisions',action.workspaceId),{fields:action.fields,options:action.options,expected_version:action.version,request_id:action.generationRequestId});
        state.pending=null;applyDocument(saved.document,{preserveManaged:acknowledgesAction(saved.document,action,action.version+1)});text($('certification-status'),'Revision {0} saved. Open it in Certificate revisions.',[saved.revision.revision]);
        $('certification-status').className='helper certification-save-status';
        window.CeasefireNotifications?.show($('certification-status'));
        if(state.workspaceId===action.workspaceId)window.dispatchEvent(new CustomEvent('ceasefire:certification-revision-saved',
          {detail:{workspace_id:action.workspaceId,project_id:state.projectId}}));
      }
    }catch(error){
      if(error.status&&!error.uncertain)state.pending=null;
      if(error.status===409)state.conflicted=true;
      message(state.pending?'The operation result could not be confirmed. Retry the same button to recover it without creating another revision.':error.message,true);
    }finally{state.busy=false;updateControls();endActivity?.();}
  }
  scopeControls.forEach(control=>control.addEventListener('change',()=>{if(!state.busy&&!state.pending&&!state.opening&&!state.readingSignature)scopeChange();}));
  $('certification-scopes').addEventListener('keydown',event=>{
    if(event.key==='Escape'){$('certification-scopes').open=false;$('certification-scopes').querySelector('summary')?.focus();event.preventDefault();}
  });
  window.addEventListener('click',event=>{if(!$('certification-scopes').contains(event.target))$('certification-scopes').open=false;});
  for(const [name,control]of Object.entries(controls))control.addEventListener('input',()=>{
    if(state.busy||state.pending||state.opening||state.readingSignature)return;state.touched.add(name);
    control.setCustomValidity('');
    control.removeAttribute('aria-invalid');fieldErrors.get(name)?.setAttribute('hidden','');
    updateControls();message(dirty()?'Unsaved certification details':'Saved certification details');
  });
  for(const id of ['client','site-address','project-no'])$(id)?.addEventListener('input',refreshInheritedFields);
  form.addEventListener('submit',event=>event.preventDefault());
  workflow?.addEventListener('change',()=>{
    if(workflow.disabled || !window.ClassifireDocumentBoard?.stages.includes(workflow.value))return;
    state.options.workflow_status=workflow.value;updateControls();message('Unsaved certification details');window.CeasefireProject?.changed?.();
  });
  saveButton?.addEventListener('click',()=>perform('save'));
  generateButton.addEventListener('click',event=>{if(!(event.detail>1))return perform('generate');});
  selector.addEventListener('change',()=>{if(selector.value)return loadDocument(selector.value);});
  newButton?.addEventListener('click',()=>loadDocument(null));
  window.addEventListener('ceasefire:company-settings-saved',event=>{if(typeof event.detail?.name==='string')companyText(event.detail.name);});
  window.addEventListener('ceasefire:languagechange',()=>{renderScopes();renderDocuments();});
  window.CeasefireCertification={open,projectWorkspace,completeProjectSnapshot,prepareProject,applyProject,markProjectSaved,discardPreparedSession,
    sessionId:()=>state.workspaceId,projectFingerprint,hasProjectChanges:()=>state.loaded&&state.projectBaseline!==null&&state.projectBaseline!==projectFingerprint(),
    hasUnsavedChanges:()=>dirty()||!!state.pending,
    hasPendingOperation:()=>!!state.opening||!!state.workspaceOpening||state.busy||state.readingSignature||!!state.pending,
    fingerprint:()=>JSON.stringify({workspace_id:state.workspaceId,id:state.id,version:state.version,fields:fields(),options:{scopes:state.options.scopes,cover_pdf_name:state.options.cover_pdf_name,signature_name:state.options.signature_name,signature_revision:state.signatureRevision,workflow_status:state.options.workflow_status},pending:state.pending&&{kind:state.pending.kind,id:state.pending.id,version:state.pending.version,createRequestId:state.pending.createRequestId,generationRequestId:state.pending.generationRequestId}})};
  const fieldErrors = new Map();
  function clearFieldErrors(){
    for(const [name,control]of Object.entries(controls)){control.setCustomValidity('');control.removeAttribute('aria-invalid');fieldErrors.get(name)?.setAttribute('hidden','');}
  }
  function validateGeneration(){
    let first;
    for(const name of requiredNames){
      const control=controls[name],invalid=!meaningful(control.value);
      control.setCustomValidity(invalid?(window.CeasefireI18n?.translate?.('This field is required.')||'This field is required.'):'');
      if(invalid){control.setAttribute('aria-invalid','true');fieldErrors.get(name)?.removeAttribute('hidden');first ||= control;}
      else{control.removeAttribute('aria-invalid');fieldErrors.get(name)?.setAttribute('hidden','');}
    }
    if(!first)return true;
    for(let section=first.parentElement;section;section=section.parentElement)if(section.tagName==='DETAILS')section.open=true;
    message('Complete all required certificate fields.',true);first.focus();return false;
  }
  for(const [name,control]of Object.entries(controls)){
    control.required=requiredNames.includes(name);
    if(!control.required)continue;
    const label=control.parentElement?.querySelector('span');
    if(label){label.id='certification-'+name+'-label';control.setAttribute('aria-labelledby',label.id);}
    control.setAttribute('aria-required','true');
    const error=node('span');error.className='certification-field-error';error.id='certification-'+name+'-error';error.hidden=true;text(error,'This field is required.');
    control.setAttribute('aria-describedby',error.id);control.parentElement?.append(error);fieldErrors.set(name,error);
  }
  renderRevisions([]);renderScopes();renderSignature();updateControls();
})();
