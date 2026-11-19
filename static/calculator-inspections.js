(() => {
  'use strict';
  const methods = {steel_board:'Steel (board)', steel_intumescent:'Steel (intumescent)', steel_vermiculite:'Steel (spray)'};
  const phases = {before:'Before Photos', during:'During Photos', after:'After Photos', gauge:'Photo of Gauge'};
  const definitions = {
    duct:{title:'Duct Inspections', view:'duct-inspections', calculator:'ductwork', endpoint:'duct-inspections.pdf',
      columns:[['location','Location'],['duct_size','Duct Size (mm)']]},
    steel:{title:'Structural Steel Inspections', view:'structural-steel-inspections', calculator:'', endpoint:'structural-steel-inspections.pdf',
      columns:[['location','Location'],['section_id','Section ID'],['critical_temp','Critical Temp (°C)']]}
  };
  const commonColumns = [['product','Product'],['frl','FRL'],['quantity','Qty'],['length','Length (m)'],['report','Report'],['required_thickness','Required Thickness (mm)']];
  const label = entry => String(entry.number).padStart(3,'0');
  let registers, revision = 0, saved = 0, epoch = 0, activeKind, fieldIndex = 0, hasRegister = false;
  let readingDrafts = new WeakMap(), photoPixels = new Map();
  const states = {};
  const clone = value => structuredClone(value);
  const readingInputFormat = new Intl.NumberFormat('en',{useGrouping:false,maximumSignificantDigits:21});
  const readingText = value => value === 0 ? '0' : readingInputFormat.format(value);
  const activeEstimateId = () => window.CeasefireEstimates?.activeId?.() || 'estimate-1';
  const currentEntry = kind => registers[kind].entries[states[kind].current] || states[kind].placeholder;
  const rootFor = kind => document.getElementById(definitions[kind].view + '-root');
  const visible = kind => activeKind === kind && rootFor(kind)?.closest('.view')?.hidden !== true;
  const busy = () => Object.values(states).some(state => state.photos || state.loading || state.exporting);
  function element(tag, className, text, args = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) window.CeasefireI18n.text(node, text, args);
    return node;
  }
  function field(text, control, args = []) {
    const wrapper = element('label','field'), caption = element('span','',text,args);
    caption.id = 'calculator-inspection-label-' + (++fieldIndex);
    control.setAttribute('aria-labelledby',caption.id);
    wrapper.append(caption,control);
    return wrapper;
  }
  function button(text, fn) {
    const node = element('button','button secondary',text);
    node.type = 'button'; node.addEventListener('click',fn); return node;
  }
  function newEntry(kind) {
    return {entry_id:crypto.randomUUID(), number:registers[kind].next_number, row:null,
      before:[], during:[], after:[], gauge:[], readings:[], plan_pins:[]};
  }
  function todayInSydney() {
    const dates = window.ClassifireDates;
    return dates.parseDate(dates.date(Date.now(), {timeZone:'Australia/Sydney'}));
  }
  function changed(kind) {
    const register = registers[kind], state = states[kind];
    if (!register.entries.length) { register.entries.push(state.placeholder); register.next_number++; }
    hasRegister = true; revision++;
    window.CeasefireProject.changed();
    refreshEntryList(kind);
    for (const node of rootFor(kind).querySelectorAll('[data-inspection-action="remove"]')) node.disabled = false;
  }
  function status(kind, text) {
    states[kind].message = text;
    const node = rootFor(kind).querySelector('[role="status"]');
    if (node) window.CeasefireI18n.text(node,text);
  }
  function refreshEntryList(kind) {
    const select = states[kind].entrySelect;
    if (!select) return;
    const register = registers[kind], rows = register.entries.length ? register.entries : [states[kind].placeholder];
    select.replaceChildren(...rows.map((entry,index) => {
      const row = entry.row;
      return new Option(label(entry) + ': ' + (row ? [row.location, row.duct_size || row.section_id, row.product].filter(Boolean).join(' · ') : 'New inspection'), String(index));
    }));
    select.value = String(states[kind].current);
  }
  function readingValues(entry) {
    const drafts = readingDrafts.get(entry) || entry.readings.map(readingText);
    const values = [];
    for (const draft of drafts) {
      const text = draft.trim(), value = Number(text);
      if (!text) continue;
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(value) || value > 100000)
        return {error:'Enter a thickness from 0 to 100000 mm for each reading.'};
      values.push(value);
    }
    return {values, average:roundedReadingAverage(values)};
  }
  function roundedReadingAverage(values) {
    if (!values.length) return null;
    // Match PDF rounding by summing the saved decimal values in integer units.
    const readings = values.map(value => {
      const [whole,fraction = ''] = readingText(value).split('.');
      return {units:BigInt(whole + fraction),places:fraction.length};
    });
    const places = Math.max(2,...readings.map(reading => reading.places));
    const total = readings.reduce((sum,reading) => sum + reading.units * 10n ** BigInt(places - reading.places),0n);
    const divisor = BigInt(readings.length) * 10n ** BigInt(places - 2);
    return Number((total + divisor / 2n) / divisor) / 100;
  }
  function formatReading(value) {
    return value == null ? '—' : new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(value);
  }
  function updateReadings(kind, entry) {
    const result = readingValues(entry), root = rootFor(kind);
    for (const output of root.querySelectorAll('[data-inspection-average]')) output.textContent = result.error ? '—' : formatReading(result.average);
    for (const output of root.querySelectorAll('[data-inspection-count]')) output.textContent = result.error ? '—' : String(result.values.length);
    const error = root.querySelector('[data-inspection-reading-error]');
    if (error) window.CeasefireI18n.text(error,result.error || '');
    if (!result.error) entry.readings = result.values;
  }
  function readingsSection(kind, entry) {
    const card = element('section','card calculator-inspection-readings');
    card.append(element('h2','','Recorded Thickness (mm)'));
    const list = element('div','calculator-inspection-reading-list');
    let drafts = readingDrafts.get(entry);
    if (!drafts) { drafts = entry.readings.length ? entry.readings.map(readingText) : ['']; readingDrafts.set(entry,drafts); }
    const renderInputs = () => {
      list.replaceChildren();
      drafts.forEach((value,index) => {
        const row = element('div','calculator-inspection-reading'), input = element('input');
        input.type = 'text'; input.inputMode = 'decimal'; input.maxLength = 24; input.value = value;
        input.name = 'recorded_thickness_' + index;
        input.addEventListener('input', () => { drafts[index] = input.value; updateReadings(kind,entry); changed(kind); });
        row.append(field('Reading {0} (mm)',input,[index+1]));
        row.append(window.ClassifireFormControls.iconButton('Remove reading','remove',() => {
          drafts.splice(index,1); if (!drafts.length) drafts.push('');
          updateReadings(kind,entry); changed(kind); renderInputs();
        }));
        list.append(row);
      });
    };
    renderInputs(); card.append(list);
    const add = button('Add reading',() => { if (drafts.length < 200) { drafts.push(''); renderInputs(); list.lastElementChild.querySelector('input').focus(); } });
    const summary = element('div','calculator-inspection-reading-summary');
    for (const [text,key] of [['Average thickness (mm)','average'],['Number of readings','count']]) {
      const output = element('output'); output.dataset['inspection' + key[0].toUpperCase() + key.slice(1)] = '';
      summary.append(field(text,output));
    }
    card.append(add,summary);
    const error = element('p','helper error'); error.dataset.inspectionReadingError = ''; error.setAttribute('aria-live','polite'); card.append(error);
    return card;
  }
  async function loadRows(kind) {
    const state = states[kind], calculatorId = registers[kind].calculator_id, token = ++state.request;
    if (!calculatorId) { state.rows = []; state.notes = {}; state.loading = false; render(kind); return; }
    const context = epoch, estimateId = activeEstimateId();
    state.loading = true; state.message = ''; render(kind);
    try {
      const snapshot = await window.CeasefireCalculators.captureTakeoffTarget(calculatorId);
      if (context !== epoch || token !== state.request) return;
      const response = await fetch('/api/project/inspection-calculator-rows', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({calculator_id:calculatorId,inputs:snapshot.inputs,schedule_rows:snapshot.schedule_rows})});
      const result = await response.json();
      if (context !== epoch || token !== state.request) return;
      if (!response.ok) throw new Error(result.error || 'The calculator register could not be loaded.');
      if (estimateId !== activeEstimateId() || window.CeasefireCalculators.projectFingerprint() !== snapshot.fingerprint) throw new Error('The calculator changed. Refresh its register to select the latest rows.');
      if (result.calculator_id !== calculatorId || !Array.isArray(result.rows)) throw new Error('The calculator register response is invalid.');
      state.rows = result.rows;
      state.notes = result.notes || {};
      state.estimateId = estimateId;
      if (!state.rows.length) state.message = 'This calculator register has no populated rows.';
    } catch(error) { if (context === epoch && token === state.request) { state.rows = []; state.notes = {}; state.message = error.message; } }
    finally { if (context === epoch && token === state.request) { state.loading = false; if (visible(kind)) render(kind); } }
  }
  function sameSnapshot(kind, saved, row) {
    return [...definitions[kind].columns,...commonColumns].every(([key]) => saved[key] === row[key]);
  }
  function sameSource(kind, entry, row, source) {
    const saved = entry.row;
    if (!saved || saved.calculator_id !== row.calculator_id || saved.line !== row.line) return false;
    const estimateId = entry.source_estimate_id || source.onlyEstimate;
    // An older entry with several possible source estimates can be matched
    // only by its recorded values.
    return estimateId ? estimateId === source.estimateId : sameSnapshot(kind,saved,row);
  }
  function sourceSection(kind, entry) {
    const register = registers[kind], state = states[kind], card = element('section','card calculator-inspection-source');
    const estimateId = activeEstimateId(), rows = state.estimateId === estimateId ? state.rows : [];
    const estimates = window.CeasefireEstimates?.list?.();
    const source = {estimateId, onlyEstimate:estimates?.length === 1 ? estimates[0].id : null};
    const available = rows.filter(row => sameSource(kind,entry,row,source) ||
      !register.entries.some(other => other !== entry && sameSource(kind,other,row,source)));
    const controls = element('div','calculator-inspection-source-controls'), select = element('select');
    const dateInput = element('input');
    dateInput.type = 'date'; dateInput.name = 'inspection_date';
    dateInput.min = '0001-01-01'; dateInput.max = '9999-12-31';
    dateInput.value = entry.inspection_date || '';
    dateInput.addEventListener('change',() => {
      if (!dateInput.validity.valid || dateInput.value === entry.inspection_date) return;
      entry.inspection_date = dateInput.value;
      if (register.entries.length || dateInput.value) changed(kind);
    });
    const dateField = field('Inspection date',dateInput);
    dateField.classList.add('calculator-inspection-date');
    select.name = 'calculator_register_row';
    select.add(new Option(window.CeasefireI18n.translate('Select'),''));
    for (const row of available) select.add(new Option([row.line, row.location, row.duct_size || row.section_id, row.product].filter(value => value !== '' && value != null).join(' · '), String(row.line)));
    const sameMethod = entry.row?.calculator_id === register.calculator_id;
    const matchingSource = available.find(row => sameSource(kind,entry,row,source));
    const matching = matchingSource && sameSnapshot(kind,entry.row,matchingSource);
    if (sameMethod && !matching) select.add(new Option(window.CeasefireI18n.translate('Saved calculator row') + ' · ' + entry.row.line,'saved'));
    select.value = matching ? String(entry.row.line) : sameMethod ? 'saved' : '';
    select.disabled = state.loading || !register.calculator_id;
    select.addEventListener('change',() => {
      const row = available.find(item => String(item.line) === select.value);
      if (!row || state.loading || entry !== currentEntry(kind) || estimateId !== activeEstimateId()) return;
      entry.row = clone(row);
      entry.source_estimate_id = estimateId;
      changed(kind); render(kind);
    });
    const refresh = button('Refresh register',() => loadRows(kind));
    refresh.disabled = state.loading || !register.calculator_id;
    controls.append(dateField,field('Calculator register row',select),refresh); card.append(controls);
    if (state.loading) card.append(element('p','helper','Loading calculator register…'));
    if (!state.loading && rows.length && !available.length) {
      card.append(element('p','helper','All calculator rows are assigned to other inspections.'));
    }
    if (entry.row) {
      const scroll = element('div','table-scroll'), table = element('table','calculator-inspection-table');
      const caption = element('caption','',entry.row.calculator_id === 'ductwork' ? 'Duct calculator register' : methods[entry.row.calculator_id]);
      const head = element('thead'), body = element('tbody'), headings = element('tr'), row = element('tr');
      for (const [key,text] of [...definitions[kind].columns,...commonColumns]) {
        const th = element('th','',text); th.scope = 'col'; headings.append(th);
        const td = element('td'); td.textContent = entry.row[key] === '' || entry.row[key] == null ? '—' : String(entry.row[key]); row.append(td);
      }
      const th = element('th','','Recorded Thickness (mm)'); th.scope = 'col'; headings.append(th);
      const average = element('td'); average.dataset.inspectionAverage = ''; row.append(average);
      const countHeading = element('th','','Number of readings'); countHeading.scope = 'col'; headings.append(countHeading);
      const count = element('td'); count.dataset.inspectionCount = ''; row.append(count);
      head.append(headings); body.append(row); table.append(caption,head,body); scroll.append(table); card.append(scroll);
      if (!entry.row.required_thickness || entry.row.required_thickness === 'N / A') {
        const diagnosis = matching && state.notes[entry.row.line];
        if (diagnosis) card.append(element('p','helper',diagnosis));
        card.append(element('p','helper error','The selected row has no calculated required thickness. Review the calculator, then refresh the register and select the updated row.'));
      } else if (matchingSource && !matching) {
        card.append(element('p','helper','The calculator result has changed. Select the row again to use its latest values.'));
      }
    }
    return card;
  }
  async function readPhoto(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20*1024*1024) throw new Error('Select JPEG, PNG or WebP photos up to 20 MB each.');
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = element('canvas'), scale = Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
      canvas.width = Math.max(1,Math.round(bitmap.width*scale)); canvas.height = Math.max(1,Math.round(bitmap.height*scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.78));
      if (!jpeg || jpeg.size > 1024*1024) throw new Error('The register photo limit has been reached.');
      const url = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(jpeg); });
      return {url,pixels:canvas.width*canvas.height};
    } finally { bitmap.close(); }
  }
  async function photoTotals() {
    const total = {encoded:0,pixels:0};
    for (const register of Object.values(registers)) for (const entry of register.entries) for (const key of Object.keys(phases)) for (const url of entry[key]) {
      if (!photoPixels.has(url)) { const image = new Image(); image.src = url; await image.decode(); photoPixels.set(url,image.naturalWidth*image.naturalHeight); }
      total.encoded += url.length; total.pixels += photoPixels.get(url);
    }
    return total;
  }
  function photoField(kind, entry, key, text) {
    const group = element('div','register-photo-field'), input = element('input');
    input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.multiple = true; input.name = key + '_photos';
    input.addEventListener('change',async () => {
      const files = [...input.files]; if (!files.length || busy()) return;
      const state = states[kind], context = epoch;
      state.photos = true; state.message = 'Preparing photos…'; render(kind);
      try {
        if (files.length + entry[key].length > 20) throw new Error('The register photo limit has been reached.');
        const added = [], total = await photoTotals();
        for (const file of files) {
          const photo = await readPhoto(file); total.encoded += photo.url.length; total.pixels += photo.pixels;
          if (total.encoded > 10*1024*1024 || total.pixels > 128000000) throw new Error('The register photo limit has been reached.');
          added.push(photo);
        }
        if (context !== epoch || entry !== currentEntry(kind)) return;
        for (const photo of added) { entry[key].push(photo.url); photoPixels.set(photo.url,photo.pixels); }
        changed(kind); state.message = '';
      } catch(error) { if (context === epoch) state.message = error.message; }
      finally { if (context === epoch) { state.photos = false; if (visible(kind)) render(kind); } }
    });
    group.append(field(text,input));
    if (key === 'gauge') {
      const optional = element('p','helper','Optional');
      optional.id = 'calculator-inspection-optional-' + (++fieldIndex);
      input.setAttribute('aria-describedby',optional.id);
      group.append(optional);
    }
    entry[key].forEach((url,index) => {
      const figure = element('figure'), image = element('img'); image.src = url; image.alt = text + ' ' + (index+1); image.loading = 'lazy';
      figure.append(image,window.ClassifireFormControls.iconButton('Remove photo','remove',() => { entry[key].splice(index,1); changed(kind); render(kind); })); group.append(figure);
    });
    return group;
  }
  async function download(kind, trigger) {
    const state = states[kind]; if (busy()) return;
    try {
      const snapshot = capture().value?.[kind];
      if (!snapshot?.entries.length || snapshot.entries.some(entry => !entry.row)) throw new Error('Select a calculator register row for each inspection before downloading.');
      state.exporting = true;
      for (const node of rootFor(kind).querySelectorAll('[data-inspection-action="pdf"]')) node.disabled = true;
      const result = await window.CeasefireDownloads.save('/api/project/' + definitions[kind].endpoint,
        {register:snapshot,project_details:window.CeasefireProject.details(),...window.ClassifireRegisterPlans?.exportContext(snapshot)}, {button:trigger});
      if (result?.saved) { status(kind,''); window.CeasefireDialogs.message({i18nSource:'File saved to {0}.{1}',i18nArgs:[result.path,'']}); }
    } catch(error) { status(kind,error.message); }
    finally { state.exporting = false; for (const node of rootFor(kind).querySelectorAll('[data-inspection-action="pdf"]')) node.disabled = false; }
  }
  function actions(kind, entry) {
    const state = states[kind], register = registers[kind], icon = window.ClassifireFormControls.iconButton;
    const back = icon('Back','back',() => window.CeasefireProject.openDocumentation());
    const add = icon('Add entry','add',() => {
      register.entries.push({...newEntry(kind),inspection_date:todayInSydney()});
      register.next_number++; state.current = register.entries.length-1;
      changed(kind); state.message = ''; render(kind);
    }); add.disabled = register.entries.length >= 200;
    const remove = icon('Remove entry','remove',async () => {
      const context = epoch;
      if (!register.entries.length || !await window.CeasefireDialogs.confirm('Remove this register entry?','Remove entry and its photos?','Remove entry')) return;
      if (context !== epoch || currentEntry(kind) !== entry) return;
      register.entries.splice(state.current,1); state.current = Math.max(0,state.current-1); state.placeholder = newEntry(kind);
      hasRegister = true; revision++; window.CeasefireProject.changed(); state.message = ''; render(kind);
    }); remove.disabled = !register.entries.length; remove.dataset.inspectionAction = 'remove';
    const pdf = icon('Download PDF','pdf',event => download(kind,event.currentTarget)); pdf.dataset.inspectionAction = 'pdf'; pdf.disabled = state.exporting;
    return [back,add,remove,pdf];
  }
  function methodSection() {
    const group = element('fieldset','register-choices calculator-inspection-methods'); group.append(element('legend','','Steel calculator'));
    for (const [id,text] of Object.entries(methods)) {
      const wrapper = element('label'), input = element('input'); input.type = 'checkbox'; input.name = 'inspection_steel_method'; input.value = id;
      input.checked = registers.steel.calculator_id === id;
      input.addEventListener('change',() => {
        if (!input.checked) { input.checked = true; return; }
        registers.steel.calculator_id = id; hasRegister = true; revision++; window.CeasefireProject.changed();
        states.steel.rows = []; void loadRows('steel');
      }); wrapper.append(input,element('span','',text)); group.append(wrapper);
    }
    return group;
  }
  function render(kind) {
    const root = rootFor(kind); if (!root) return false;
    const state = states[kind], entry = currentEntry(kind), form = element('fieldset','register-form calculator-inspection-form');
    const defaultedDate = !Object.hasOwn(entry,'inspection_date');
    if (defaultedDate) entry.inspection_date = todayInSydney();
    form.disabled = state.photos;
    if (kind === 'steel') form.append(methodSection());
    const toolbar = element('div','register-toolbar register-actions card'), select = element('select');
    select.name = 'inspection_entry'; state.entrySelect = select; refreshEntryList(kind);
    select.addEventListener('change',() => { state.current = Number(select.value); state.message = ''; render(kind); });
    toolbar.append(field('Register entry',select),...actions(kind,entry));
    const notice = element('p','helper',state.message); notice.setAttribute('role','status');
    form.append(toolbar,notice,sourceSection(kind,entry));
    const photos = element('section','card'), grid = element('div','register-grid');
    for (const [key,text] of Object.entries(phases)) if (key !== 'gauge') grid.append(photoField(kind,entry,key,text));
    photos.append(grid); form.append(photos,readingsSection(kind,entry));
    const gauge = element('section','card'); gauge.append(photoField(kind,entry,'gauge',phases.gauge)); form.append(gauge);
    if (window.ClassifireRegisterPlans) form.append(window.ClassifireRegisterPlans.section({entry,entries:registers[kind].entries,changed:() => changed(kind),el:element,field,label,optional:true}));
    form.append(window.ClassifireFormControls.registerSignature({entry, el:element, field,
      isCurrent:() => visible(kind) && currentEntry(kind) === entry,
      onChange:() => { changed(kind); state.message = ''; render(kind); },
      onError:error => status(kind,error)}));
    const footer = element('div','register-footer-actions register-actions'); footer.append(...actions(kind,entry));
    form.append(element('p','helper','Save the project to keep this register.'),footer); root.replaceChildren(form); updateReadings(kind,entry);
    if (defaultedDate && registers[kind].entries.length) changed(kind);
    return true;
  }
  function capture() {
    if (Object.values(states).some(state => state.photos || state.loading)) throw new Error('Finish preparing the inspection register before continuing.');
    for (const register of Object.values(registers)) for (const entry of register.entries) {
      const result = readingValues(entry); if (result.error) throw new Error(result.error); entry.readings = result.values;
    }
    return {revision,value:hasRegister ? clone(registers) : null};
  }
  function applyProject(snapshot) {
    epoch++; window.ClassifireRegisterPlans?.close(); photoPixels.clear(); readingDrafts = new WeakMap();
    registers = {};
    for (const [kind,definition] of Object.entries(definitions)) {
      registers[kind] = clone(snapshot?.[kind] || {calculator_id:definition.calculator,entries:[],next_number:1});
      states[kind] = {current:0,rows:[],notes:{},estimateId:null,request:0,loading:false,photos:false,exporting:false,message:'',entrySelect:null};
      states[kind].placeholder = newEntry(kind); rootFor(kind)?.replaceChildren();
    }
    hasRegister = Boolean(snapshot); saved = ++revision;
  }
  window.ClassifireCalculatorInspections = {
    capture,applyProject,busy,revision:() => revision,hasProjectChanges:() => revision !== saved,
    markSaved(snapshot) { if (snapshot?.revision === revision) saved = revision; },
    async open(kind) { if (!definitions[kind]) throw new Error('Choose an inspection register.'); activeKind = kind; render(kind); await loadRows(kind); return true; }
  };
  applyProject();
})();
