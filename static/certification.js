(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('certification-form');
  if (!form) return;
  const fieldNames = ['client', 'project', 'address', 'location_area', 'statement_of_compliance',
    'australian_standards', 'ncc_clauses', 'approved_design', 'additional_standards',
    'other_references', 'exclusions', 'materials_manufacturers', 'fire_resistance_level',
    'name', 'position', 'qualification', 'accreditation'];
  const signerNames = ['name', 'position', 'qualification', 'accreditation'];
  const controls = Object.fromEntries(fieldNames.map(name => [name, $('certification-' + name)]));
  const selector = $('certification-document'), saveButton = $('certification-save'), generateButton = $('certification-generate');
  const coverFile = $('certification-cover-pdf'), coverDelete = $('certification-cover-delete');
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
  const emptyOptions = () => ({cover_pdf:null, cover_pdf_name:'', scopes:[]});
  const state = {id:null, version:null, baseline:null, busy:false, pending:null, loaded:false,
    items:[], listRevision:0, companyName:'', companyCoverName:'', opening:null, conflicted:false,
    options:emptyOptions(), coverRevision:0, readingCover:false, touched:new Set(),
    managed:{australian_standards:[], ncc_clauses:[]}, managedByDocument:new Map(),
    defaults:{fields:Object.fromEntries(signerNames.map(name=>[name,''])), version:1},
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
    return state.conflicted || !!state.defaultsDesired || !equal(fields(),state.baseline.fields) ||
      state.options.cover_pdf !== state.baseline.options.cover_pdf || state.options.cover_pdf_name !== state.baseline.options.cover_pdf_name ||
      !equal(state.options.scopes,state.baseline.options.scopes);
  }
  function updateControls() {
    const locked = !state.loaded || !!state.opening || state.busy || !!state.pending || state.readingCover;
    for (const control of [...Object.values(controls), ...scopeControls, selector, coverFile]) control.disabled = locked;
    coverDelete.disabled = locked || !state.options.cover_pdf;
    saveButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingCover || (!!state.pending && state.pending.kind !== 'save');
    generateButton.disabled = !state.loaded || !!state.opening || state.busy || state.readingCover || (!!state.pending && state.pending.kind !== 'generate');
    form.setAttribute('aria-busy', String(state.busy || !!state.opening || state.readingCover));
  }
  function companyText(name) {
    state.companyName = name;
    text($('certification-exclusions-intro'),
      'Certification is strictly limited to passive fire protection works completed by {0}, in accordance with:', [name]);
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
  const uuid = () => window.crypto.randomUUID();
  const signerFields = () => Object.fromEntries(signerNames.map(name=>[name,controls[name].value]));
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
        const saved=await post('/api/certifications/defaults',{fields:desired,expected_version:version});
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
    state.defaultsDesired=signerFields();
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
  function renderCover() {
    const host=$('certification-cover-name');
    if(state.options.cover_pdf)text(host,'Cover sheet: {0}',[state.options.cover_pdf_name||'Cover sheet.pdf']);
    else if(state.companyCoverName)text(host,'Company cover sheet will be used: {0}',[state.companyCoverName]);
    else text(host,'No cover sheet selected.');
  }
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
      const expected='/api/certifications/'+encodeURIComponent(state.id)+'/revisions/'+revision.revision+'.pdf';
      if(!Number.isInteger(revision.revision)||revision.revision<1||revision.pdf_url!==expected)throw new Error('The saved certificate link is invalid.');
      link.href=expected;link.target='_blank';link.rel='noopener';text(link,'Open revision {0}',[revision.revision]);cell.append(link);row.append(number,when,cell);body.append(row);
    }
    table.append(head,body);host.replaceChildren(table);
  }
  function normalizeOptions(value) {
    const result={...emptyOptions(),...(value||{})};
    if(!Array.isArray(result.scopes)||result.scopes.some(id=>!scopes.some(scope=>scope.id===id)))throw new Error('The saved certification scope is invalid.');
    result.scopes=scopes.filter(scope=>result.scopes.includes(scope.id)).map(scope=>scope.id);return result;
  }
  function applyDocument(saved, {preserveManaged=false}={}) {
    const cached=state.managedByDocument.get(saved.id);
    const known=preserveManaged?state.managed:cached?.version===saved.version?cached.managed:null;
    ++state.listRevision;state.id=saved.id;state.version=saved.version;state.conflicted=false;state.touched.clear();
    for(const name of fieldNames)controls[name].value=saved.fields[name]||'';
    state.options=normalizeOptions(saved.options);state.coverRevision++;
    // Acknowledged local saves retain ownership. Unknown saved text is treated
    // as authored content, never silently deleted when a scope is cleared.
    state.managed=Object.fromEntries(['australian_standards','ncc_clauses'].map(name=>[name,
      (known?.[name]||[]).filter(line=>controls[name].value.split(/\r?\n/).includes(line))]));
    state.managedByDocument.set(saved.id,{version:saved.version,managed:{australian_standards:[...state.managed.australian_standards],ncc_clauses:[...state.managed.ncc_clauses]}});
    state.baseline=snapshot();
    const index=state.items.findIndex(item=>item.id===saved.id);
    if(index<0)state.items.unshift(saved);else state.items[index]=saved;
    renderDocuments();renderScopes();renderCover();renderRevisions(saved.revisions||[]);
  }
  function acknowledgesAction(saved,action,version) {
    const savedOptions=normalizeOptions(saved.options);
    return saved.version===version && fieldNames.every(name=>saved.fields[name]===action.fields[name]) &&
      savedOptions.cover_pdf===action.options.cover_pdf && savedOptions.cover_pdf_name===action.options.cover_pdf_name &&
      equal(savedOptions.scopes,action.options.scopes);
  }
  function inheritedFields() {
    const project=window.CeasefireProject?.details?.()||{};
    return {client:project.client||'',project:project.project_no||'',address:project.site_address||'',
      exclusions:'Project No.: '+(project.project_no||''),statement_of_compliance:statement,...state.defaults.fields};
  }
  function refreshInheritedFields() {
    if(state.id||!state.loaded||state.busy||state.pending||state.readingCover)return;
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
    if(captured!==smallStamp(snapshot())||id!==state.id||state.busy||state.pending||state.readingCover){
      message('Certification details changed during the confirmation. Review the current fields first.',true);return false;
    }
    return true;
  }
  function freshFields() {
    for(const name of fieldNames)controls[name].value='';
    Object.entries(inheritedFields()).forEach(([name,value])=>{controls[name].value=value;});
    state.id=state.version=null;state.conflicted=false;state.touched.clear();state.options=emptyOptions();state.coverRevision++;
    state.managed={australian_standards:[],ncc_clauses:[]};state.baseline=snapshot();coverFile.value='';
    renderDocuments();renderScopes();renderCover();renderRevisions([]);updateControls();message('Enter the certification details.');
  }
  async function loadDocument(id) {
    if(state.busy||state.pending||state.opening||state.readingCover||!await confirmDiscard()){selector.value=state.id||'__draft__';return;}
    if(state.busy||state.pending||state.opening||state.readingCover){selector.value=state.id||'__draft__';return;}
    state.busy=true;updateControls();
    try{
      if(!await flushSignerDefaults({interactive:true})){selector.value=state.id||'__draft__';message('Signer details are still unsaved. Your certification details are kept.',true);return;}
      if(!id){state.defaults=await request('/api/certifications/defaults');freshFields();return;}
      message('Loading certification…');applyDocument(await request('/api/certifications/'+encodeURIComponent(id)));message('Saved certification details');
    }catch(error){selector.value=state.id||'__draft__';message(error.message,true);}
    finally{state.busy=false;updateControls();}
  }
  async function loadList() {
    const revision=++state.listRevision,data=await request('/api/certifications');
    if(revision!==state.listRevision)return;state.items=data.items||[];renderDocuments();
  }
  async function open() {
    if(state.opening)return state.opening;
    message('Loading certification…');
    state.opening=(async()=>{
      const [company,defaults]=await Promise.all([request('/api/company-settings'),request('/api/certifications/defaults')]);
      companyText(company.name);state.companyCoverName=company.cover_pdf?(company.cover_pdf_name||'Cover sheet.pdf'):'';
      if(!state.defaultsDesired&&!state.defaultsSaving)state.defaults=defaults;
      await loadList();
      if(!state.loaded){state.loaded=true;freshFields();}
      else{refreshInheritedFields();renderCover();message(dirty()?'Unsaved certification details':'Saved certification details');}
    })();updateControls();
    try{return await state.opening;}finally{state.opening=null;updateControls();}
  }
  async function perform(kind) {
    if(!state.loaded||state.opening||state.busy||state.readingCover||(state.pending&&state.pending.kind!==kind))return;
    if(!form.reportValidity())return;
    const action=state.pending||{kind,...snapshot(),id:state.id,version:state.version,createRequestId:uuid(),generationRequestId:uuid()};
    state.pending=action;state.busy=true;updateControls();
    message(kind==='generate'?'Generating and saving certificate revision…':'Saving certification details…');
    const endActivity=window.CeasefireActivity?.begin();
    try{
      if(!await flushSignerDefaults({interactive:true})){
        state.pending=null;message('Signer details are still unsaved. Your certification details are kept.',true);return;
      }
      if(!action.id){
        const created=await post('/api/certifications',{fields:action.fields,options:action.options,request_id:action.createRequestId});
        action.id=created.id;action.version=created.version;applyDocument(created,{preserveManaged:acknowledgesAction(created,action,1)});
        if(kind==='save'){state.pending=null;message('Certification details saved.');return;}
      }
      if(kind==='save'){
        const saved=await post('/api/certifications/'+encodeURIComponent(action.id),{fields:action.fields,options:action.options,expected_version:action.version});
        state.pending=null;applyDocument(saved,{preserveManaged:acknowledgesAction(saved,action,action.version+1)});message('Certification details saved.');
      }else{
        const saved=await post('/api/certifications/'+encodeURIComponent(action.id)+'/revisions',{fields:action.fields,options:action.options,expected_version:action.version,request_id:action.generationRequestId});
        state.pending=null;applyDocument(saved.document,{preserveManaged:acknowledgesAction(saved.document,action,action.version+1)});text($('certification-status'),'Revision {0} saved. Open it in Certificate revisions.',[saved.revision.revision]);
        $('certification-status').className='helper certification-save-status';
      }
    }catch(error){
      if(error.status&&!error.uncertain)state.pending=null;
      if(error.status===409)state.conflicted=true;
      message(state.pending?'The operation result could not be confirmed. Retry the same button to recover it without creating another revision.':error.message,true);
    }finally{state.busy=false;updateControls();endActivity?.();}
  }
  coverFile.addEventListener('change',async()=>{
    const chosen=coverFile.files?.[0];if(!chosen||state.busy||state.pending||state.opening||state.readingCover)return;
    if((!/\.pdf$/i.test(chosen.name)&&chosen.type!=='application/pdf')||chosen.size>10*1024*1024||!chosen.size){message('Choose a PDF cover sheet smaller than 10 MB.',true);coverFile.value='';return;}
    state.readingCover=true;updateControls();const endActivity=window.CeasefireActivity?.begin();
    try{
      const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('The PDF cover sheet could not be read.'));reader.readAsDataURL(chosen);});
      state.options.cover_pdf='data:application/pdf;base64,'+String(value).split(',')[1];state.options.cover_pdf_name=chosen.name;state.coverRevision++;
      renderCover();message('Unsaved certification details');
    }catch(error){message(error.message,true);}finally{state.readingCover=false;coverFile.value='';updateControls();endActivity?.();}
  });
  coverDelete.addEventListener('click',()=>{if(state.busy||state.pending||state.opening||state.readingCover)return;state.options.cover_pdf=null;state.options.cover_pdf_name='';state.coverRevision++;coverFile.value='';renderCover();updateControls();message(dirty()?'Unsaved certification details':'Saved certification details');});
  scopeControls.forEach(control=>control.addEventListener('change',()=>{if(!state.busy&&!state.pending&&!state.opening&&!state.readingCover)scopeChange();}));
  $('certification-scopes').addEventListener('keydown',event=>{
    if(event.key==='Escape'){$('certification-scopes').open=false;$('certification-scopes').querySelector('summary')?.focus();event.preventDefault();}
  });
  window.addEventListener('click',event=>{if(!$('certification-scopes').contains(event.target))$('certification-scopes').open=false;});
  for(const [name,control]of Object.entries(controls))control.addEventListener('input',()=>{
    if(state.busy||state.pending||state.opening||state.readingCover)return;state.touched.add(name);
    if(signerNames.includes(name))queueSignerDefaults();message(dirty()?'Unsaved certification details':'Saved certification details');
  });
  for(const id of ['client','site-address','project-no'])$(id)?.addEventListener('input',refreshInheritedFields);
  form.addEventListener('submit',event=>event.preventDefault());
  saveButton.addEventListener('click',()=>perform('save'));
  generateButton.addEventListener('click',event=>{if(!(event.detail>1))return perform('generate');});
  selector.addEventListener('change',()=>{if(selector.value==='__draft__')return;return loadDocument(selector.value==='__reload__'?state.id:selector.value);});
  window.addEventListener('ceasefire:company-settings-saved',event=>{if(typeof event.detail?.name==='string')companyText(event.detail.name);});
  window.addEventListener('ceasefire:languagechange',renderScopes);
  window.CeasefireCertification={open,hasUnsavedChanges:()=>dirty()||!!state.pending,
    hasPendingOperation:()=>!!state.opening||state.busy||state.readingCover||!!state.pending||!!state.defaultsSaving||!!state.defaultsTimer,
    fingerprint:()=>JSON.stringify({id:state.id,version:state.version,fields:fields(),options:{scopes:state.options.scopes,cover_pdf_name:state.options.cover_pdf_name,cover_revision:state.coverRevision},pending:state.pending&&{kind:state.pending.kind,id:state.pending.id,version:state.pending.version,createRequestId:state.pending.createRequestId,generationRequestId:state.pending.generationRequestId},signerDefaultsPending:state.defaultsDesired})};
  renderRevisions([]);renderScopes();renderCover();updateControls();
})();
