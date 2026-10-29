(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('certification-form');
  if (!form) return;
  const fieldNames = ['client', 'project', 'address', 'location_area', 'statement_of_compliance',
    'australian_standards', 'ncc_clauses', 'approved_design', 'additional_standards',
    'other_references', 'exclusions', 'materials_manufacturers', 'fire_resistance_level',
    'name', 'position', 'qualification', 'accreditation'];
  const signerNames = ['name', 'position', 'qualification', 'accreditation'];
  const requiredNames = fieldNames.filter(name => !signerNames.includes(name));
  const controls = Object.fromEntries(fieldNames.map(name => [name, $('certification-' + name)]));
  const selector = $('certification-document'), saveButton = $('certification-save'), generateButton = $('certification-generate');
  const signatureCanvas = $('certification-signature-canvas'), signatureDelete = $('certification-signature-delete');
  const signatureSave = $('certification-signature-save'), signatureClear = $('certification-signature-clear');
  const legacyOpen=$('certification-legacy-open'),legacyDialog=$('certification-legacy-dialog'),legacySelector=$('certification-legacy-document'),legacyImport=$('certification-legacy-import');
  const drawing = {strokes:[], active:null, revision:0};
  const statement = "This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule. All materials have been installed at the above location and comply with:";
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
    workspaceId:null, projectId:null, workspaceOpening:null, projectBaseline:null, legacyOpen:false,
    options:emptyOptions(), signatureRevision:0, readingSignature:false, signatureTouched:false, touched:new Set(),
    managed:{australian_standards:[], ncc_clauses:[]}, managedByDocument:new Map(),
    defaults:{fields:Object.fromEntries(signerNames.map(name=>[name,''])),signature_image:null,signature_name:'',version:1},
    defaultsDesired:null, defaultsSaving:null, defaultsTimer:null, defaultsError:null};
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
  }
  function signerMessage(source, error=false) {
    text($('certification-signer-status'), source);
    $('certification-signer-status').className = error ? 'message error' : 'helper';
  }
  function dirty() {
    return !!drawing.strokes.length || !!drawing.active || state.conflicted || !!state.defaultsDesired || !equal(fields(),state.baseline.fields) ||
      state.options.cover_pdf !== state.baseline.options.cover_pdf || state.options.cover_pdf_name !== state.baseline.options.cover_pdf_name ||
      state.options.signature_image !== state.baseline.options.signature_image || state.options.signature_name !== state.baseline.options.signature_name ||
      !equal(state.options.scopes,state.baseline.options.scopes);
  }
  function updateControls() {
    const locked = !state.loaded || !!state.opening || state.busy || !!state.pending || state.readingSignature || state.legacyOpen;
    for (const control of [...Object.values(controls), ...scopeControls, selector]) control.disabled = locked;
    signatureCanvas.setAttribute('aria-disabled', String(locked));
    signatureSave.disabled = locked || !drawing.strokes.length || !!drawing.active;
    signatureClear.disabled = locked || !drawing.strokes.length && !drawing.active;
    signatureDelete.disabled = locked || !state.options.signature_image;
    legacyOpen.disabled=locked;
    saveButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingSignature || state.legacyOpen || (!!state.pending && state.pending.kind !== 'save');
    generateButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingSignature || state.legacyOpen || (!!state.pending && state.pending.kind !== 'generate');
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
  const signerFields = () => Object.fromEntries(signerNames.map(name=>[name,controls[name].value]));
  // Opening an older unsigned certificate must not clear the separately saved
  // signature when the user only edits a name or qualification. Image changes
  // enter the shared defaults only after an explicit save or removal.
  const signerSnapshot = () => ({fields:signerFields(),...(state.signatureTouched?{signature_image:state.options.signature_image,signature_name:state.options.signature_name}:{})});
  async function flushSignerDefaults({interactive=false}={}) {
    if (state.defaultsTimer) { clearTimeout(state.defaultsTimer); state.defaultsTimer=null; }
    if (state.defaultsSaving) { const succeeded=await state.defaultsSaving; return succeeded && state.defaultsDesired ? flushSignerDefaults({interactive}) : succeeded; }
    if (!state.defaultsDesired) return true;
    if (state.defaultsError?.status===409) {
      if (!interactive) return false;
      const accepted = await window.CeasefireDialogs.confirm('Signer details changed',
        'Signer details were changed in another window. Use the entered details for future certificates?', 'Use entered details', 'Keep editing');
      if (!accepted) return false;
      try { state.defaults=await request('/api/certifications/defaults'); }
      catch(error) { signerMessage(error.message,true); return false; }
    }
    const desired={...state.defaultsDesired}, version=state.defaults.version;
    state.defaultsSaving=(async()=>{
      try {
        const saved=await post('/api/certifications/defaults',{...desired,expected_version:version});
        state.defaults=saved;state.defaultsError=null;
        if(equal(desired,state.defaultsDesired))state.defaultsDesired=null;
        signerMessage('Signer details saved for future certificates.');return true;
      } catch(error) {
        state.defaultsError=error;
        signerMessage(error.status===409 ? 'Signer details changed in another window. Your entries are kept. Save again to review and retry.' : 'Signer details could not be saved. Your entries are kept; save again to retry.',true);
        return false;
      }
    })();
    const succeeded=await state.defaultsSaving;state.defaultsSaving=null;
    return succeeded && state.defaultsDesired ? flushSignerDefaults({interactive}) : succeeded;
  }
  function queueSignerDefaults() {
    state.defaultsDesired=signerSnapshot();
    signerMessage('Saving signer details…');
    if(state.defaultsTimer)clearTimeout(state.defaultsTimer);
    state.defaultsTimer=setTimeout(()=>{state.defaultsTimer=null;void flushSignerDefaults();},450);
  }
  function label(item) {
    const value=item.fields||item;
    return [value.project,value.client,value.address].filter(Boolean).join(' · ') || 'Certificate '+item.id.slice(0,8);
  }
  function renderDocuments() {
    const fresh=node('option');fresh.value='';text(fresh,'New certificate');
    const draft=node('option');draft.value='__draft__';text(draft,'Current certificate');
    const saved=state.items.map(item=>{const option=node('option',label(item));option.value=item.id;return option;});
    if(state.id){const reload=node('option');reload.value='__reload__';text(reload,'Reload saved details');saved.push(reload);}
    selector.replaceChildren(...(state.id?[fresh]:[draft,fresh]),...saved);selector.value=state.id||'__draft__';
  }
  function renderSignature() {
    const preview=$('certification-signature-preview');
    preview.hidden=!state.options.signature_image;
    if(state.options.signature_image)preview.src=state.options.signature_image;
    else preview.removeAttribute('src');
    if(state.options.signature_image)text($('certification-signature-name'),'Signature: {0}',[state.options.signature_name]);
    else text($('certification-signature-name'),'No signature selected.');
  }
  function drawSignature() {
    const context=signatureCanvas.getContext('2d'),width=signatureCanvas.width,height=signatureCanvas.height;
    context.clearRect(0,0,width,height);
    context.strokeStyle='#14181f';context.fillStyle='#14181f';context.lineWidth=Math.max(1,width/350);
    context.lineCap='round';context.lineJoin='round';
    for(const stroke of [...drawing.strokes,...(drawing.active?[drawing.active.points]:[])]){
      if(stroke.length===1){context.beginPath();context.arc(stroke[0].x*width,stroke[0].y*height,context.lineWidth/2,0,Math.PI*2);context.fill();}
      else{context.beginPath();stroke.forEach((point,index)=>context[index?'lineTo':'moveTo'](point.x*width,point.y*height));context.stroke();}
    }
  }
  function resizeSignature() {
    const bounds=signatureCanvas.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    const ratio=Math.min(3,Math.max(1,window.devicePixelRatio||1));
    const width=Math.max(1,Math.round(bounds.width*ratio)),height=Math.max(1,Math.round(bounds.height*ratio));
    if(signatureCanvas.width!==width||signatureCanvas.height!==height){signatureCanvas.width=width;signatureCanvas.height=height;drawSignature();}
  }
  function clearDrawing({announce=false}={}) {
    if(drawing.active){try{signatureCanvas.releasePointerCapture(drawing.active.id);}catch{} }
    drawing.strokes=[];drawing.active=null;drawing.revision++;drawSignature();updateControls();
    text($('certification-signature-drawing-status'),announce?'Signature drawing cleared.':'');
  }
  function signatureLocked() {return !state.loaded||!!state.opening||state.busy||!!state.pending||state.readingSignature||state.legacyOpen;}
  function signaturePoint(event) {
    const bounds=signatureCanvas.getBoundingClientRect();
    return {x:Math.min(1,Math.max(0,(event.clientX-bounds.left)/bounds.width)),y:Math.min(1,Math.max(0,(event.clientY-bounds.top)/bounds.height))};
  }
  signatureCanvas.addEventListener('pointerdown',event=>{
    if(signatureLocked()||drawing.active||event.button!==undefined&&event.button!==0)return;
    event.preventDefault();resizeSignature();
    drawing.active={id:event.pointerId,points:[signaturePoint(event)]};drawing.revision++;
    signatureCanvas.setPointerCapture(event.pointerId);drawSignature();updateControls();
    text($('certification-signature-drawing-status'),'Unsaved signature drawing.');
  });
  signatureCanvas.addEventListener('pointermove',event=>{
    if(drawing.active?.id!==event.pointerId||signatureLocked())return;
    event.preventDefault();
    for(const point of event.getCoalescedEvents?.()||[event])drawing.active.points.push(signaturePoint(point));
    drawing.revision++;drawSignature();
  });
  signatureCanvas.addEventListener('pointerup',event=>{
    if(drawing.active?.id!==event.pointerId)return;
    event.preventDefault();drawing.active.points.push(signaturePoint(event));
    drawing.strokes.push(drawing.active.points);drawing.active=null;drawing.revision++;
    if(signatureCanvas.hasPointerCapture(event.pointerId))signatureCanvas.releasePointerCapture(event.pointerId);
    drawSignature();updateControls();message('Unsaved certification details');
  });
  function cancelStroke(event) {
    if(drawing.active?.id!==event.pointerId)return;
    drawing.active=null;drawing.revision++;drawSignature();updateControls();
    text($('certification-signature-drawing-status'),drawing.strokes.length?'Unsaved signature drawing.':'');
  }
  signatureCanvas.addEventListener('pointercancel',cancelStroke);
  signatureCanvas.addEventListener('lostpointercapture',cancelStroke);
  signatureClear.addEventListener('click',()=>{if(!signatureLocked()){clearDrawing({announce:true});message(dirty()?'Unsaved certification details':'Saved certification details');}});
  signatureSave.addEventListener('click',()=>{
    if(signatureLocked()||drawing.active||!drawing.strokes.length)return;
    const image=signatureCanvas.toDataURL('image/png');
    if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>2800000){message('The signature drawing could not be saved. Please clear it and try again.',true);return;}
    state.options.signature_image=image;state.options.signature_name='Drawn signature.png';state.signatureRevision++;state.signatureTouched=true;
    clearDrawing();renderSignature();queueSignerDefaults();message('Unsaved certification details');
    text($('certification-signature-drawing-status'),'Signature saved.');
  });
  if(window.ResizeObserver)new window.ResizeObserver(resizeSignature).observe(signatureCanvas);
  window.addEventListener('resize',resizeSignature);
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
      link.href=expected;link.target='_blank';link.rel='noopener';text(link,'Open revision {0}',[revision.revision]);cell.append(link);row.append(number,when,cell);body.append(row);
    }
    table.append(head,body);host.replaceChildren(table);
  }
  function normalizeOptions(value) {
    const result={...emptyOptions(),...(value||{})};
    if(!Array.isArray(result.scopes)||result.scopes.some(id=>!scopes.some(scope=>scope.id===id)))throw new Error('The saved certification scope is invalid.');
    result.scopes=scopes.filter(scope=>result.scopes.includes(scope.id)).map(scope=>scope.id);
    if(typeof result.signature_name!=='string'||result.signature_name.length>200||/[\/\\\x00-\x1f]/.test(result.signature_name)||
      result.signature_image!==null&&(typeof result.signature_image!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(result.signature_image)))throw new Error('Choose a PNG or JPEG signature smaller than 2 MB.');
    return result;
  }
  function applyDocument(saved, {preserveManaged=false}={}) {
    const cached=state.managedByDocument.get(saved.id);
    const known=preserveManaged?state.managed:cached?.version===saved.version?cached.managed:null;
    ++state.listRevision;state.id=saved.id;state.version=saved.version;state.conflicted=false;state.touched.clear();
    for(const name of fieldNames)controls[name].value=saved.fields[name]||'';
    state.options=normalizeOptions(saved.options);state.signatureRevision++;state.signatureTouched=false;clearDrawing();
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
      equal(savedOptions.scopes,action.options.scopes);
  }
  function inheritedFields() {
    const project=window.CeasefireProject?.details?.()||{};
    return {client:project.client||'',project:project.project_no||'',address:project.site_address||'',
      exclusions:'Project No.: '+(project.project_no||''),statement_of_compliance:statement,
      approved_design:'N/A',additional_standards:'N/A',other_references:'N/A',...state.defaults.fields};
  }
  function refreshInheritedFields() {
    if(state.id||!state.loaded||state.busy||state.pending||state.readingSignature)return;
    for(const [name,value]of Object.entries(inheritedFields()))if(!state.touched.has(name)){
      controls[name].value=value;state.baseline.fields[name]=value;
    }
    if(!state.signatureTouched){
      state.options.signature_image=state.defaults.signature_image||null;state.options.signature_name=state.defaults.signature_name||'';
      state.baseline.options.signature_image=state.options.signature_image;state.baseline.options.signature_name=state.options.signature_name;
      renderSignature();
    }
  }
  async function confirmDiscard() {
    if(!dirty())return true;
    const captured=smallStamp(snapshot()),id=state.id,drawingRevision=drawing.revision;
    const accepted=await window.CeasefireDialogs.confirm('Unsaved certification details',
      'Continue without saving these certification details?','Continue without saving','Keep editing');
    if(!accepted)return false;
    if(captured!==smallStamp(snapshot())||id!==state.id||drawingRevision!==drawing.revision||state.busy||state.pending||state.readingSignature){
      message('Certification details changed during the confirmation. Review the current fields first.',true);return false;
    }
    return true;
  }
  function freshFields() {
    for(const name of fieldNames)controls[name].value='';
    Object.entries(inheritedFields()).forEach(([name,value])=>{controls[name].value=value;});
    state.id=state.version=null;state.conflicted=false;state.touched.clear();state.signatureTouched=false;
    state.options={...emptyOptions(),signature_image:state.defaults.signature_image||null,signature_name:state.defaults.signature_name||''};state.signatureRevision++;
    state.managed={australian_standards:[],ncc_clauses:[]};state.baseline=snapshot();clearDrawing();
    renderDocuments();renderScopes();renderSignature();renderRevisions([]);updateControls();message('Enter the certification details.');
  }
  async function loadDocument(id) {
    if(state.busy||state.pending||state.opening||state.readingSignature||!await confirmDiscard()){selector.value=state.id||'__draft__';return;}
    if(state.busy||state.pending||state.opening||state.readingSignature){selector.value=state.id||'__draft__';return;}
    state.busy=true;updateControls();
    try{
      if(!await flushSignerDefaults({interactive:true})){selector.value=state.id||'__draft__';message('Signer details are still unsaved. Your certification details are kept.',true);return;}
      if(!id){state.defaults=await request('/api/certifications/defaults');freshFields();return;}
      message('Loading certification…');applyDocument(await request(scoped('/api/certifications/'+encodeURIComponent(id))));message('Saved certification details');
    }catch(error){selector.value=state.id||'__draft__';message(error.message,true);}
    finally{state.busy=false;updateControls();}
  }
  async function loadList() {
    const revision=++state.listRevision,data=await request(scoped('/api/certifications'));
    if(revision!==state.listRevision)return;state.items=data.items||[];renderDocuments();
  }
  const projectCaptures=new WeakMap();
  function projectFingerprint() {
    return JSON.stringify({workspace_id:state.workspaceId,draft:{id:state.id,version:state.version,...snapshot()},
      documents:state.items.map(item=>({id:item.id,version:item.version,revision_count:item.revision_count??item.revisions?.length??0})).sort((a,b)=>a.id.localeCompare(b.id)),
      drawing_revision:drawing.strokes.length||drawing.active?drawing.revision:0});
  }
  async function ensureWorkspace() {
    if(state.workspaceId)return;
    if(!state.workspaceOpening)state.workspaceOpening=post('/api/certifications/workspaces',{});
    try{
      const prepared=await state.workspaceOpening;
      state.workspaceId=prepared.workspace_id;state.projectId=prepared.project_id;state.items=prepared.items||[];
    }finally{state.workspaceOpening=null;}
  }
  async function completeProjectSnapshot() {
    if(state.busy||state.pending||state.opening||state.workspaceOpening||state.legacyOpen)throw new Error('Finish the current certificate operation before saving the project.');
    if(drawing.strokes.length||drawing.active)throw new Error('Save or clear the signature drawing before saving certification details.');
    if(!state.loaded)await open();
    if(!await flushSignerDefaults({interactive:true}))throw new Error('Signer details are still unsaved. Your certification details are kept.');
    if(state.busy||state.pending||state.opening)throw new Error('Finish the current certificate operation before saving the project.');
    const capture={workspace_id:state.workspaceId,draft:{id:state.id,version:state.version,...snapshot()}};
    projectCaptures.set(capture,projectFingerprint());return capture;
  }
  async function prepareProject(manifest,workspaceId) {
    if(manifest&&!workspaceId)throw new Error('Load this saved project through Projects to restore its certificate evidence.');
    const prepared=workspaceId?await request('/api/certifications/workspaces/'+encodeURIComponent(workspaceId)):await post('/api/certifications/workspaces',{});
    if(typeof prepared.workspace_id!=='string'||!prepared.workspace_id||!Array.isArray(prepared.items))throw new Error('The current project certificate workspace is unavailable.');
    if(prepared.draft?.id)prepared.current=await request(scoped('/api/certifications/'+encodeURIComponent(prepared.draft.id),prepared.workspace_id));
    if(prepared.draft)normalizeOptions(prepared.draft.options);
    return prepared;
  }
  function applyProject(prepared) {
    if(state.busy||state.pending||state.opening||state.defaultsSaving||state.legacyOpen)throw new Error('Finish the current certificate operation before changing projects.');
    ++state.listRevision;state.workspaceId=prepared.workspace_id;state.projectId=prepared.project_id;
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
      const [company,defaults]=await Promise.all([request('/api/company-settings'),request('/api/certifications/defaults')]);
      companyText(company.name);
      if(!state.defaultsDesired&&!state.defaultsSaving)state.defaults=defaults;
      await ensureWorkspace();
      await loadList();
      if(!state.loaded){state.loaded=true;freshFields();state.projectBaseline=projectFingerprint();}
      else{refreshInheritedFields();renderSignature();message(dirty()?'Unsaved certification details':'Saved certification details');}
      resizeSignature();
    })();updateControls();
    try{return await state.opening;}finally{state.opening=null;updateControls();}
  }
  async function perform(kind) {
    if(!state.loaded||state.opening||state.busy||state.readingSignature||state.legacyOpen||(state.pending&&state.pending.kind!==kind))return;
    if(drawing.strokes.length||drawing.active){message('Save or clear the signature drawing before saving certification details.',true);return;}
    if(!state.pending){
      for(const name of requiredNames)controls[name].setCustomValidity(controls[name].value.trim()?'':window.CeasefireI18n?.translate?.('Complete all required certificate fields.')||'Complete all required certificate fields.');
      if(!form.reportValidity())return;
    }
    const action=state.pending||{kind,...snapshot(),id:state.id,version:state.version,workspaceId:state.workspaceId,createRequestId:uuid(),generationRequestId:uuid()};
    state.pending=action;state.busy=true;updateControls();
    message(kind==='generate'?'Generating and saving certificate revision…':'Saving certification details…');
    const endActivity=window.CeasefireActivity?.begin();
    try{
      if(!await flushSignerDefaults({interactive:true})){
        state.pending=null;message('Signer details are still unsaved. Your certification details are kept.',true);return;
      }
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
      }
    }catch(error){
      if(error.status&&!error.uncertain)state.pending=null;
      if(error.status===409)state.conflicted=true;
      message(state.pending?'The operation result could not be confirmed. Retry the same button to recover it without creating another revision.':error.message,true);
    }finally{state.busy=false;updateControls();endActivity?.();}
  }
  signatureDelete.addEventListener('click',()=>{
    if(state.busy||state.pending||state.opening||state.readingSignature)return;
    state.options.signature_image=null;state.options.signature_name='';state.signatureRevision++;state.signatureTouched=true;clearDrawing();
    renderSignature();queueSignerDefaults();updateControls();message(dirty()?'Unsaved certification details':'Saved certification details');
  });
  legacyOpen.addEventListener('click',async()=>{
    if(signatureLocked())return;
    state.busy=true;updateControls();
    try{
      const data=await request('/api/certifications/legacy'),choose=node('option');choose.value='';text(choose,'Choose…');
      legacySelector.replaceChildren(choose,...(data.items||[]).map(item=>{const option=node('option',label(item));option.value=item.id;return option;}));
      legacySelector.value='';legacyImport.disabled=!(data.items||[]).length;
      text($('certification-legacy-status'),data.items?.length?'':'No older certificates are available.');
      state.legacyOpen=true;legacyDialog.showModal();
    }catch(error){message(error.message,true);}
    finally{state.busy=false;updateControls();}
  });
  legacyImport.addEventListener('click',async()=>{
    if(state.busy||!state.legacyOpen||!legacySelector.reportValidity()||!legacySelector.value)return;
    if(!await confirmDiscard())return;
    state.busy=true;legacySelector.disabled=legacyImport.disabled=$('certification-legacy-cancel').disabled=true;updateControls();
    try{
      if(!await flushSignerDefaults({interactive:true}))return;
      const result=await post('/api/certifications/workspaces/'+encodeURIComponent(state.workspaceId)+'/import',{document_id:legacySelector.value});
      applyDocument(result.document);legacyDialog.close('imported');state.legacyOpen=false;
      message('The older certificate was added to this project. Its saved revisions are retained.');
    }catch(error){text($('certification-legacy-status'),error.message);}
    finally{state.busy=false;legacySelector.disabled=legacyImport.disabled=$('certification-legacy-cancel').disabled=false;updateControls();}
  });
  legacyDialog.addEventListener('cancel',event=>{if(state.busy)event.preventDefault();});
  legacyDialog.addEventListener('close',()=>{state.legacyOpen=false;updateControls();});
  scopeControls.forEach(control=>control.addEventListener('change',()=>{if(!state.busy&&!state.pending&&!state.opening&&!state.readingSignature)scopeChange();}));
  $('certification-scopes').addEventListener('keydown',event=>{
    if(event.key==='Escape'){$('certification-scopes').open=false;$('certification-scopes').querySelector('summary')?.focus();event.preventDefault();}
  });
  window.addEventListener('click',event=>{if(!$('certification-scopes').contains(event.target))$('certification-scopes').open=false;});
  for(const [name,control]of Object.entries(controls))control.addEventListener('input',()=>{
    if(state.busy||state.pending||state.opening||state.readingSignature)return;state.touched.add(name);
    control.setCustomValidity('');
    if(signerNames.includes(name))queueSignerDefaults();message(dirty()?'Unsaved certification details':'Saved certification details');
  });
  for(const id of ['client','site-address','project-no'])$(id)?.addEventListener('input',refreshInheritedFields);
  form.addEventListener('submit',event=>event.preventDefault());
  saveButton.addEventListener('click',()=>perform('save'));
  generateButton.addEventListener('click',event=>{if(!(event.detail>1))return perform('generate');});
  selector.addEventListener('change',()=>{if(selector.value==='__draft__')return;return loadDocument(selector.value==='__reload__'?state.id:selector.value);});
  window.addEventListener('ceasefire:company-settings-saved',event=>{if(typeof event.detail?.name==='string')companyText(event.detail.name);});
  window.addEventListener('ceasefire:languagechange',renderScopes);
  window.CeasefireCertification={open,completeProjectSnapshot,prepareProject,applyProject,markProjectSaved,discardPreparedSession,
    sessionId:()=>state.workspaceId,projectFingerprint,hasProjectChanges:()=>state.loaded&&state.projectBaseline!==null&&state.projectBaseline!==projectFingerprint(),
    hasUnsavedChanges:()=>dirty()||!!state.pending,
    hasPendingOperation:()=>!!state.opening||!!state.workspaceOpening||state.busy||state.readingSignature||state.legacyOpen||!!state.pending||!!state.defaultsSaving||!!state.defaultsTimer,
    fingerprint:()=>JSON.stringify({workspace_id:state.workspaceId,id:state.id,version:state.version,fields:fields(),options:{scopes:state.options.scopes,cover_pdf_name:state.options.cover_pdf_name,signature_name:state.options.signature_name,signature_revision:state.signatureRevision},drawing_revision:drawing.strokes.length||drawing.active?drawing.revision:0,pending:state.pending&&{kind:state.pending.kind,id:state.pending.id,version:state.pending.version,createRequestId:state.pending.createRequestId,generationRequestId:state.pending.generationRequestId},signerDefaultsPending:state.defaultsDesired&&{fields:state.defaultsDesired.fields,signature_name:state.defaultsDesired.signature_name,signature_revision:state.signatureRevision}})};
  requiredNames.forEach(name=>{controls[name].required=true;});
  renderRevisions([]);renderScopes();renderSignature();updateControls();
})();
