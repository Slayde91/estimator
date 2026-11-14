(() => {
  'use strict';
  let sequence = 0;
  const clone = value => structuredClone(value);
  const empty = value => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
  const pictureTypes = ['image/jpeg','image/png','image/webp','image/gif'];
  const videoTypes = ['video/mp4','video/webm'];
  const mediaTypes = [...pictureTypes,...videoTypes];
  const MiB = 1024 * 1024;
  const translate = value => window.CeasefireI18n?.translate(value) || value;
  function el(tag, cls, content) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = String(content);
    return node;
  }
  function button(name, fn) {
    const control = el('button','button secondary',translate(name));
    control.type = 'button'; control.addEventListener('click',fn); return control;
  }
  function input(type, value = '') {
    const control = el('input'); control.type = type; control.value = value ?? ''; return control;
  }
  function labelled(name, control) {
    const wrap = el('label','form-field-part'); wrap.append(el('span','',translate(name)),control); return wrap;
  }
  function select(choices, value, many = false) {
    const control = el('select'); control.multiple = many;
    if (!many) control.append(new Option(translate('Select…'),''));
    for (const [id,name] of choices) {
      const option = new Option(name,id);
      option.selected = many ? Array.isArray(value) && value.includes(String(id)) : value === String(id);
      control.append(option);
    }
    return control;
  }
  function conditionMet(condition, dictionary) {
    if (!condition?.field_id) return true;
    const source = dictionary[condition.field_id];
    const actual = source?.answer ?? source;
    return Array.isArray(actual) ? actual.some(value => String(value) === String(condition.value))
      : actual != null && String(actual) === String(condition.value);
  }
  function base64Bytes(value) {
    return typeof value === 'string' ? Math.max(0, Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)) : 0;
  }
  function evidenceBytes(value) {
    if (typeof value==='string' && value.startsWith('data:image/png;base64,')) return base64Bytes(value.slice(22));
    if (!value || typeof value !== 'object') return 0;
    if (typeof value.data === 'string' && typeof value.name === 'string') return base64Bytes(value.data);
    return Object.values(value).reduce((total,item) => total+evidenceBytes(item),0);
  }
  function asDataURL(file) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('The file could not be read.'));
      reader.onabort = () => reject(Error('The file could not be read.'));
      reader.readAsDataURL(file);
    });
  }
  function mount(host, template, options = {}) {
    const initial = options.values || {};
    const values = clone(initial);
    const stages = template.settings?.stages || [];
    const workflow = template.mode === 'workflow';
    const stage = options.stageId ?? stages[0]?.id;
    const locked = new Set(options.lockedStages || []);
    const staff = Array.isArray(options.staff) ? options.staff : [];
    const entries = Array.isArray(options.entries) ? options.entries : [];
    const member = options.member || {};
    const conditions = new Map(), checks = new Map();
    const fieldBoxes = new WeakMap();
    const formulaOutputs = new Map(), listProperties = new Map();
    let calculationTimer, calculationVersion = 0;
    let pending = 0;
    const root = el('div','form-fields');
    host.replaceChildren(root);
    const personName = id => staff.find(person=>person.id === id)?.name || (member.id === id && member.name) || id;
    const refLabel = entry => [entry.name || entry.title, entry.created_by_name, entry.created_at && window.ClassifireDates.dateTime(entry.created_at), entry.id].filter(Boolean).join(' · ');
    function scheduleCalculation() {
      const current = ++calculationVersion;
      clearTimeout(calculationTimer);
      if (!formulaOutputs.size || typeof options.calculate !== 'function') return;
      calculationTimer = setTimeout(async () => {
        if (!root.isConnected) return;
        try {
          const result = await options.calculate(values);
          if (current !== calculationVersion || !root.isConnected) return;
          for (const update of formulaOutputs.values()) update(result);
        } catch {
          if (current === calculationVersion && root.isConnected) {
            for (const update of formulaOutputs.values()) update(null);
          }
        }
      }, 180);
    }
    function changed() {
      for (const update of conditions.values()) update();
      for (const update of listProperties.values()) update();
      scheduleCalculation();
      if (options.onChange?.length) options.onChange(clone(values));
      else options.onChange?.();
    }
    function teamChoices(value) {
      const ids = new Set(Array.isArray(value) ? value : value ? [value] : []);
      const result = staff.filter(person=>person.active !== false || ids.has(person.id)).map(person=>[person.id,person.name || person.id]);
      for (const id of ids) if (!result.some(([key])=>key === id)) result.push([id,personName(id)]);
      return result;
    }
    function errorText(node, text) {
      node.textContent = text ? translate(text) : ''; node.hidden = !text;
    }
    function renderFields(container, fields, dictionary, inheritedLock = false, parentStage = null, parents = [], tableContext = null) {
      if (!fieldBoxes.has(dictionary)) fieldBoxes.set(dictionary,new Map());
      const siblings=fieldBoxes.get(dictionary);
      for (const field of fields || []) {
        const id = field.id, type = field.type;
        const fieldStage = field.stage_id || parentStage || stages[0]?.id;
        const readOnly = inheritedLock || options.readOnly || (workflow && (fieldStage !== stage || locked.has(fieldStage)));
        const box = el('div','form-field');
        if(field.hide_in_pdf)box.classList.add('form-hide-in-print');
        box.dataset.fieldId = id; box.dataset.fieldType = type;
        container.append(box);
        siblings.set(id,box);
        const visible = () => parents.every(ancestor=>!ancestor.hidden) &&
          !siblings.get(field.condition?.field_id)?.hidden && conditionMet(field.condition,dictionary);
        let seeded = Object.hasOwn(dictionary,id);
        const startingDefault = !seeded && !readOnly && field.default != null ? clone(field.default) : undefined;
        const value = () => Object.hasOwn(dictionary,id) ? dictionary[id] : undefined;
        const set = next => {
          if (readOnly || !root.isConnected || !root.contains(box)) return;
          seeded = true;
          if (next == null || next === '') delete dictionary[id]; else dictionary[id] = next;
          errorText(error,''); changed();
        };
        const updateVisibility = () => {
          box.hidden = !visible();
          if (!box.hidden && !seeded && startingDefault !== undefined) {
            seeded = true; dictionary[id] = startingDefault;
          }
        };
        updateVisibility(); conditions.set(box,updateVisibility);
        if (['section','instruction','page_break'].includes(type)) {
          box.classList.add('form-layout-field');
          if (type === 'page_break') box.classList.add('form-page-break');
          box.append(el(type === 'instruction' ? 'p' : 'h3','',field.label));
          if (field.help) box.append(el('p','form-field-help',field.help)); continue;
        }
        const title = el('label','form-field-label',field.label || type);
        title.id = 'form-field-label-' + ++sequence;
        if (field.required) title.append(el('span','form-field-required',' *'));
        const body = el('div','form-field-content'), error = el('p','form-field-error'); error.hidden = true;
        error.setAttribute('role','alert');
        box.append(title);
        const help = el('p','form-field-help',field.help);
        if (field.help) { help.id = 'form-field-help-'+sequence; box.append(help); }
        box.append(body,error);
        const describe = control => {
          if (!title.htmlFor) { control.id = 'form-field-control-'+ ++sequence; title.htmlFor = control.id; }
          if (!control.hasAttribute('aria-label') && !control.closest('label')) control.setAttribute('aria-labelledby',title.id);
          if (field.help) control.setAttribute('aria-describedby',help.id);
          if (field.required) control.setAttribute('aria-required','true');
          return control;
        };
        const bind = (control, event, read) => {
          describe(control); control.addEventListener(event,()=>set(read(control))); return control;
        };
        const compound = () => { body.classList.add('form-field-parts'); };
        let verify = () => field.required && empty(value()) ? 'Complete this required field.' : '';
        const answer = value() ?? startingDefault;
        if (type === 'group' || type === 'table') {
          const items = Array.isArray(answer) ? answer : [];
          const content = el('div','form-repeat'); body.append(content);
          const children = type === 'group' ? field.children : field.columns;
          const table = type === 'table' ? el('table','form-repeat-table') : null;
          const canResize = !readOnly && (!table || field.table_mode !== 'fixed');
          const rows = table ? el('tbody') : content;
          if(table) {
            const head=el('thead'),tr=el('tr');
            table.setAttribute('aria-labelledby',title.id);
            for(const child of children || []) {
              const th=el('th',child.hide_in_pdf?'form-hide-in-print':'',child.label);
              th.scope='col';th.dataset.columnWidth=child.width || 'm';tr.append(th);
            }
            if(canResize){const th=el('th','',translate('Actions'));th.scope='col';tr.append(th);}
            head.append(tr); table.append(head,rows);content.append(table);
          }
          function row(item) {
            const rowBox = table ? el('tr') : el('fieldset','form-repeat-row'); rows.append(rowBox);
            if(table) {
              const context = {id, rowIndex:()=>items.indexOf(item)};
              for(const column of children || []) {
                const cell=el('td',column.hide_in_pdf?'form-hide-in-print':'');rowBox.append(cell);renderFields(cell,[column],item,readOnly,fieldStage,[...parents,box],context);
              }
            } else {
              rowBox.append(el('legend','',translate('Group')+' '+(items.indexOf(item)+1)));
              renderFields(rowBox, children, item, readOnly,fieldStage,[...parents,box]);
            }
            if (canResize) {
              const remove = () => {
                for (const node of rowBox.querySelectorAll('.form-field')) {
                  conditions.delete(node);checks.delete(node);formulaOutputs.delete(node);listProperties.delete(node);
                }
                items.splice(items.indexOf(item),1); rowBox.remove();
                if (!table) [...rows.children].forEach((node,index)=>{node.querySelector('legend').textContent=translate('Group')+' '+(index+1);});
                set(items);
              };
              const del = table ? button('Remove',remove) : window.ClassifireFormControls.iconButton('Remove','remove',remove);
              if(table){const cell=el('td');cell.append(del);rowBox.append(cell);}else rowBox.append(del);
            }
          }
          for (const item of items) row(item);
          if (canResize) {
            const add = () => {
              const item = {};
              items.push(item); row(item); set(items);
            };
            body.append(table ? button('Add row',add) : window.ClassifireFormControls.iconButton('Add group','add',add));
          } else if (!items.length) body.append(el('p','form-field-answer','—'));
        } else if (type === 'formula' || type === 'list_property') {
          const output=el('output','form-field-answer',answer ?? '—');
          output.setAttribute('aria-labelledby',title.id);body.append(output);
          if (!readOnly && type==='formula' && tableContext) {
            formulaOutputs.set(box,result=>{
              if (!root.contains(box)) return;
              const calculated = result?.[tableContext.id]?.[tableContext.rowIndex()]?.[id];
              output.textContent = result ? (calculated ?? '—') : translate('Calculation unavailable');
            });
          } else if (!readOnly && type==='list_property') {
            const update=()=>{
              if(!root.contains(box))return;
              const source=dictionary[field.source_column];
              output.textContent=(field.mapping && Object.hasOwn(field.mapping,source) ? field.mapping[source] : null) ?? '—';
            };
            update();listProperties.set(box,update);
          }
          verify=()=>'';
        } else if (readOnly) {
          readonlyAnswer(body, field, answer);
        } else if (['date_range','datetime_range'].includes(type)) {
          compound(); const withTime = type === 'datetime_range';
          for (const key of ['start','end']) {
            const {control,zone} = dated(withTime,field.timezone,answer?.[key],next=>set({start:'',end:'',...value(),[key]:next}));
            body.append(labelled(key === 'start' ? 'Start' : 'End',control)); describe(control);
            if (zone) control.after(zone);
          }
          verify = () => {
            const range=value(); if (!range?.start && !range?.end && !field.required) return '';
            if (!range?.start || !range?.end) return 'Enter the start and end.';
            return Date.parse(range.end) < Date.parse(range.start) ? 'The end must be on or after the start.' : '';
          };
        } else if (type === 'time') {
          const control=input('time',answer);
          control.step=60*(Number(field.interval) || 15);
          body.append(bind(control,'input',node=>node.value));
        } else if (['date','datetime','expiry_date'].includes(type)) {
          const {control,zone}=dated(type === 'datetime',field.timezone,answer,set);
          body.append(describe(control));if(zone)body.append(zone);
        } else if (type === 'yes_no') {
          const choices=(field.options?.length ? field.options : ['Yes','No','N/A']).map(name=>[name,translate(name)]);
          const control=select(choices,answer?.answer ?? answer);
          const note=el('textarea');note.value=answer?.explanation || '';
          const reason=labelled('Explanation',note);
          const needsNote=()=>field.explanation_on?.includes(control.value);
          reason.hidden=!needsNote(); body.append(describe(control),reason);
          control.addEventListener('change',()=>{
            reason.hidden=!needsNote();
            if(reason.hidden)note.value='';
            set(needsNote()?{answer:control.value,explanation:note.value}:control.value);
          });
          note.addEventListener('input',()=>set({answer:control.value,explanation:note.value}));
          verify=()=>needsNote()&&!note.value.trim()?'Enter an explanation.':field.required&&!control.value?'Complete this required field.':'';
        } else if (['choice','multichoice'].includes(type) && field.display === 'inline') {
          const multiple=type==='multichoice', group=el('div','form-inline-choices'), controls=[];
          group.setAttribute('role',multiple?'group':'radiogroup');group.setAttribute('aria-labelledby',title.id);
          for(const choice of field.options || []) {
            const control=input(multiple?'checkbox':'radio',choice);
            control.checked=multiple ? Array.isArray(answer)&&answer.includes(choice) : answer===choice;
            control.name=title.id;controls.push(control);
            const label=el('label');label.append(control,document.createTextNode(choice));group.append(label);
            control.addEventListener('change',()=>set(multiple ? controls.filter(c=>c.checked).map(c=>c.value) : control.value));
          }
          body.append(group);
        } else if (['choice','multichoice','person','lookup','relationship'].includes(type)) {
          const many = type === 'multichoice' || (type === 'person' && field.multiple);
          const reference = type==='lookup' || type==='relationship';
          let choices;
          if (type === 'person') choices=teamChoices(answer);
          else if (reference) {
            choices=entries.filter(entry=>!field.source_template_id || entry.template_id === field.source_template_id).map(entry=>[entry.id,refLabel(entry)]);
            if(answer?.entry_id && !choices.some(([id])=>id===answer.entry_id)) choices.push([answer.entry_id,answer.entry_id]);
          } else choices=(field.options || []).map(name=>[name,name]);
          const control=select(choices,reference ? answer?.entry_id : answer,many);
          body.append(bind(control,'change',node=>many ? [...node.selectedOptions].map(option=>option.value) : reference ? (node.value ? {entry_id:node.value} : null) : node.value));
        } else if (['attachment','photo'].includes(type)) {
          const control = input('file'); control.multiple = true;
          if(type==='photo') control.accept=mediaTypes.join(',');
          else if(field.accept==='application/pdf')control.accept='application/pdf';
          const list=el('ul','form-field-files'); if(type==='photo')box.dataset.photoSize=field.photo_size || 'medium';body.append(describe(control),list);
          const refresh = () => fileList(list,field,value(),{
            remove(file){set(value().filter(item=>item!==file));refresh();},
            update(file,key,next){
              if (!value()?.includes(file)) return;
              if (next.length) file[key]=next; else delete file[key];
              set(value());
            }
          });
          refresh();
          control.addEventListener('change', async () => {
            const files=[...control.files]; control.value=''; if (!files.length) return;
            if (files.length+(value()?.length || 0)>16) {errorText(error,'Choose up to 16 files per field.');return;}
            if (files.some(file=>!file.size)) {errorText(error,'Choose a file with content.');return;}
            if (files.some(file=>file.size>5*MiB)) { errorText(error,'Each file must be 5 MB or smaller.'); return; }
            if (type==='photo' && files.some(file=>!mediaTypes.includes(file.type))) { errorText(error,'Choose a PNG, JPEG, WebP, GIF, MP4 or WebM file.'); return; }
            if (control.accept==='application/pdf' && files.some(file=>file.type!=='application/pdf')) { errorText(error,'Choose a PDF file.'); return; }
            pending++; control.disabled=true;
            try {
              const added = [];
              for (const file of files) added.push({name:file.name,type:file.type || 'application/octet-stream',data:(await asDataURL(file)).split(',')[1]});
              if (evidenceBytes(values)+evidenceBytes(added)>12*MiB) throw Error('Attachments must total 12 MB or less.');
              set([...(value() || []),...added]); refresh();
            } catch(err) { errorText(error,err.message); } finally { pending--; control.disabled=false; }
          });
        } else if (type === 'manual_signature' && (isPNG(answer) || answer?.at)) {
          readonlyAnswer(body,field,answer);
        } else if (type === 'manual_signature' || type === 'sketch') {
          const manual = type==='manual_signature';
          function updateSigner(key,text) {
            const next={...value(),[key]:text};
            set(Object.values(next).some(part=>!empty(part)) ? next : null);
          }
          if (manual) {
            for(const [key,label] of [['name','Full name'],['company','Company']]) {
              const control=input('text',answer?.[key]);control.maxLength=200;
              body.append(labelled(label,control));control.addEventListener('input',()=>updateSigner(key,control.value));
            }
            verify=()=>{
              const signed=value();
              if(!field.required && !signed)return '';
              if(!signed?.name?.trim())return 'Enter the signer’s full name.';
              return isPNG(signed.image)?'':'Draw a signature.';
            };
          }
          const preview=el('img','form-field-image'); preview.alt=field.label; body.append(preview);
          const refresh=()=>{ const image=manual?value()?.image:value();preview.hidden=!isPNG(image); if(!preview.hidden)preview.src=image; else preview.removeAttribute('src'); };
          refresh();
          const capture = async () => {
            pending++; draw.disabled=true;
            try {
              if (type === 'sketch') { const data=await sketch(value()); if (data) set(data); }
              else {
                const signed=await window.ClassifireSignaturePad.choose(null,false,'document');
                if (signed) updateSigner('image',window.ClassifirePersonalSignature.png(signed));
              }
              refresh();
            } catch(err) {errorText(error,err.message);} finally {pending--; draw.disabled=false;}
          };
          const draw = manual ? window.ClassifireFormControls.iconButton('Draw signature','signature',capture) : button('Draw sketch',capture);
          body.append(draw,button('Clear',()=>{if(manual)updateSigner('image','');else set(null);refresh();}));
        } else if (type === 'location') {
          compound(); const controls = {};
          for (const [key,limit] of [['latitude',90],['longitude',180]]) {
            const control=input('number',answer?.[key]); control.min=-limit; control.max=limit; control.step='any';
            controls[key]=control;body.append(labelled(key==='latitude'?'Latitude':'Longitude',control));describe(control);
            control.addEventListener('input',()=>{const next={...value()}; if(control.value==='')delete next[key];else next[key]=Number(control.value);set(Object.keys(next).length?next:null);});
          }
          const locate=button('Use current location',()=>{
            if (!navigator.geolocation) {errorText(error,'Location is unavailable. Enter the coordinates.');return;}
            pending++;locate.disabled=true;
            navigator.geolocation.getCurrentPosition(position=>{
              pending--;locate.disabled=false;
              const next={latitude:position.coords.latitude,longitude:position.coords.longitude};
              for(const key of Object.keys(next)) controls[key].value=next[key]; set(next);
            },()=>{pending--;locate.disabled=false;errorText(error,'Location is unavailable. Enter the coordinates.');},{timeout:15000});
          });body.append(locate);
          verify=()=>{const point=value();if(!point&&!field.required)return '';return Number.isFinite(point?.latitude)&&Number.isFinite(point?.longitude)&&Math.abs(point.latitude)<=90&&Math.abs(point.longitude)<=180?'':'Enter valid latitude and longitude.';};
        } else if (type === 'action') {
          compound();const config = [
            ['description','Description',el('textarea')],['assignee','Assignee',select(teamChoices(answer?.assignee),answer?.assignee)],
            ['due_date','Due date',input('date')],['status','Status',select(['Pending','In progress','Completed','Cancelled'].map(s=>[s,translate(s)]),answer?.status || 'Pending')]
          ];
          for(const [key,label,control] of config){
            control.value=answer?.[key] ?? (key==='status'?'Pending':'');body.append(labelled(label,control));describe(control);
            control.addEventListener('input',()=>{const next={description:'',assignee:'',due_date:'',status:'Pending',...value(),[key]:control.value};set(next);});
          }
          verify=()=>value()?.description?.trim() || (!value() && !field.required) ? '' : 'Enter an action description.';
        } else if (type==='scan_id') {
          const control=input('text',answer);control.autocomplete='off';control.spellcheck=false;
          const identity=el('p','form-field-help');identity.setAttribute('role','status');
          const match=()=>staff.find(person=>person.active!==false && person.id===control.value.trim());
          const refresh=()=>{identity.textContent=!control.value.trim()?'':match()?.name || (answer===control.value ? personName(answer) : translate('No matching staff ID.'));};
          control.addEventListener('input',()=>{set(control.value.trim());refresh();});
          control.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();refresh();}});
          body.append(describe(control),identity);refresh();
          verify=()=>!control.value.trim() ? (field.required?'Enter a staff ID.':'') : match() || answer===control.value.trim() ? '' : 'Enter an ID from the staff directory.';
        } else if (['signature','approval','profile','profile_name','profile_company','profile_phone','staff_wallet'].includes(type)) {
          const checkbox=input('checkbox');checkbox.checked=Boolean(answer);
          const label={signature:'Sign as',approval:'Approve as',profile_company:'Use company name from Settings',profile_phone:'Use company phone from Settings',profile_name:'Use staff name',profile:'Use staff profile',staff_wallet:'Capture signed-in staff identity'}[type];
          body.append(labelled(translate(label)+(member.name && !['profile_phone','profile_company'].includes(type)?' '+member.name:''),checkbox));describe(checkbox);
          if (answer && (typeof answer==='string' || typeof answer==='object' && (type!=='signature' || answer.at))) {
            checkbox.disabled=true;readonlyAnswer(body,field,answer);
          } else if (type==='signature') {
            const ink=el('img','form-field-image');ink.alt=field.label;body.append(ink);
            const paint=()=>{
              const image=value()?.signature_image;
              ink.hidden=!isPNG(image);if(ink.hidden)ink.removeAttribute('src');else ink.src=image;
            };
            paint();
            checkbox.addEventListener('change',async()=>{
              if(!checkbox.checked){set(null);paint();return;}
              pending++;checkbox.disabled=true;
              try {
                const personal=window.ClassifirePersonalSignature;
                const saved=await personal?.saved();
                set(saved ? {signature_image:personal.png(saved)} : true);
                paint();
              } catch(err) {
                checkbox.checked=false;errorText(error,err.message || 'Could not load your signature profile. Try again.');
              } finally {pending--;checkbox.disabled=false;}
            });
          }
          else checkbox.addEventListener('change',()=>set(checkbox.checked || null));
          verify=()=>field.required && !value()?'Confirm this field.':'';
        } else if (type === 'counter') {
          body.append(el('p','form-field-answer',answer ?? translate('Assigned when saved.')));verify=()=>'';
        } else {
          const control=type==='textarea' ? el('textarea') : input(type==='number'?'number':'text');
          control.value=answer ?? '';if(type==='number'){control.step='any';if(field.min!=null)control.min=field.min;if(field.max!=null)control.max=field.max;}
          if(field.placeholder)control.placeholder=field.placeholder;
          body.append(bind(control,'input',node=>type==='number' && node.value!=='' ? node.valueAsNumber : node.value));
        }
        if (!readOnly) checks.set(box,() => {
          if (!root.contains(box) || !visible()) return null;
          const invalid=type==='table' || type==='group' ? null : body.querySelector('input:invalid,select:invalid,textarea:invalid');
          const problem=invalid ? invalid.validationMessage : verify();
          errorText(error,problem);return problem ? (invalid || body.querySelector('input,select,textarea,button') || title) : null;
        });
      }
    }
    function dated(withTime, includeZone, previous, write) {
      const raw=String(previous || ''), offset=withTime ? raw.match(/(Z|[+-]\d\d:\d\d)$/)?.[1] : '';
      const control=input(withTime?'datetime-local':'date',offset ? raw.slice(0,-offset.length) : raw);
      const zone=withTime && (includeZone || offset) ? el('span','form-field-help') : null;
      function zoneSuffix() {
        if (!zone || !control.value) return '';
        if (offset) return offset;
        const minutes=-new Date(control.value).getTimezoneOffset();
        return minutes===0?'Z':(minutes<0?'-':'+')+String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')+':'+String(Math.abs(minutes)%60).padStart(2,'0');
      }
      function showZone() {
        if (!zone) return;
        const suffix=zoneSuffix();
        zone.textContent=suffix ? 'UTC'+(suffix==='Z'?'':suffix) : '';
      }
      if(withTime)control.step='any';
      showZone();
      control.addEventListener('input',()=>{
        showZone();
        write(control.value ? control.value+zoneSuffix() : '');
      });
      return {control,zone};
    }
    function readonlyAnswer(body, field, answer) {
      if(empty(answer)){body.append(el('p','form-field-answer','—'));return;}
      if(['attachment','photo'].includes(field.type)){const list=el('ul','form-field-files');if(field.type==='photo')body.parentElement.dataset.photoSize=field.photo_size || 'medium';body.append(list);fileList(list,field,answer);return;}
      if(['manual_signature','sketch'].includes(field.type)&&isPNG(answer)){const image=el('img','form-field-image');image.src=answer;image.alt=field.label;body.append(image);return;}
      if(field.type==='manual_signature'&&isPNG(answer.image)){const image=el('img','form-field-image');image.src=answer.image;image.alt=field.label;body.append(image);}
      if(field.type==='signature'&&/^data:image\/(png|jpeg);base64,/.test(answer.signature_image)){const image=el('img','form-field-image');image.src=answer.signature_image;image.alt=field.label;body.append(image);}
      let shown;
      switch(field.type){
        case 'date':case 'expiry_date':shown=window.ClassifireDates.date(answer);break;
        case 'datetime':shown=window.ClassifireDates.wallTime(answer);break;
        case 'date_range':case 'datetime_range':shown=[answer.start,answer.end].filter(Boolean).map(value=>field.type==='date_range'?window.ClassifireDates.date(value):window.ClassifireDates.wallTime(value)).join(' – ');break;
        case 'location':shown=[answer.latitude,answer.longitude].join(', ');break;
        case 'person':shown=[].concat(answer).map(personName).join(', ');break;
        case 'lookup':case 'relationship':shown=refLabel(entries.find(entry=>entry.id===answer.entry_id) || {id:answer.entry_id});break;
        case 'yes_no':shown=typeof answer==='object'?[answer.answer,answer.explanation].filter(Boolean).join(' · '):answer;break;
        case 'action':shown=[answer.description,personName(answer.assignee),answer.due_date && window.ClassifireDates.date(answer.due_date),answer.status].filter(Boolean).join(' · ');break;
        case 'signature':shown=answer===true?member.name:[answer.member_name,answer.at && window.ClassifireDates.dateTime(answer.at)].filter(Boolean).join(' · ');break;
        case 'manual_signature':shown=[answer.name,answer.company,answer.at && window.ClassifireDates.dateTime(answer.at)].filter(Boolean).join(' · ');break;
        case 'staff_wallet':shown=answer===true?member.name:[answer.member_name,answer.role,answer.member_id,answer.at && window.ClassifireDates.dateTime(answer.at)].filter(Boolean).join(' · ');break;
        case 'scan_id':shown=[personName(answer),answer].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ');break;
        case 'profile':shown=answer===true?member.name:typeof answer==='object'?[answer.name,answer.email,answer.role].filter(Boolean).join(' · '):answer;break;
        case 'approval':shown=translate(answer?'Approved':'Not approved');break;
        case 'profile_company':case 'profile_phone':case 'profile_name':shown=answer===true?(field.type==='profile_name'?member.name:translate('Assigned when saved.')):answer;break;
        default:shown=Array.isArray(answer)?answer.join(', '):answer;
      }
      body.append(el('p','form-field-answer',shown));
    }
    renderFields(root, template.fields, values);
    scheduleCalculation();
    return {
      getValues:()=>clone(values),isBusy:()=>pending>0,
      validate(){if(pending)return false;const issues=Array.from(checks.values(),check=>check()).filter(Boolean);issues[0]?.focus();return !issues.length;}
    };
  }
  function photoMetadata(field,file,edit) {
    if (field.type!=='photo' || !['large','xl'].includes(field.photo_size)) return null;
    const panel=el('div','form-photo-metadata');
    for (const [key,enabled,label] of [['tags',field.show_tags,'Tags'],['description',field.show_description,'Description']]) {
      if (!enabled) continue;
      const tags=key==='tags';
      const existing=tags ? (file.tags || []).join('\n') : file.description || '';
      if (!edit) {
        if (existing) {
          const part=el('div','form-field-part');
          part.append(el('span','',translate(label)),el('p','form-field-answer',tags?file.tags.join(', '):existing));
          panel.append(part);
        }
        continue;
      }
      const control=el('textarea');control.rows=2;control.value=existing;
      if (!tags) control.maxLength=2000;
      panel.append(labelled(tags?'Tags (one per line)':label,control));
      const checkTags=list=>{
        const invalid=list.length>20 || list.some(tag=>Array.from(tag).length>80);
        control.setCustomValidity(invalid?translate('Use up to 20 tags of 80 characters each.'):'');
      };
      if(tags)checkTags(file.tags || []);
      control.addEventListener('input',()=>{
        if (!tags) {edit(file,key,control.value.trim());return;}
        const seen=new Set(),list=[];
        for (const line of control.value.split('\n')) {
          const tag=line.trim(), normalized=tag.toLowerCase();
          if(tag && !seen.has(normalized)){seen.add(normalized);list.push(tag);}
        }
        checkTags(list);
        edit(file,key,list);
      });
      if(tags)control.addEventListener('blur',()=>{control.value=(file.tags || []).join('\n');});
    }
    return panel.childElementCount ? panel : null;
  }
  function fileList(list, field, files, handlers = {}) {
    list.replaceChildren();
    for (const file of files || []) {
      const row=el('li');
      const link=el('a','',file.name); link.download=file.name;
      link.href='data:application/octet-stream;base64,'+file.data; row.append(link);
      if (pictureTypes.includes(file.type)) {const img=el('img','form-field-image');img.src='data:'+file.type+';base64,'+file.data;img.alt=file.name;row.append(img);}
      if (videoTypes.includes(file.type)) {
        const player=el('video','form-field-image');player.controls=true;player.preload='metadata';player.playsInline=true;
        player.setAttribute('aria-label',file.name);player.src='data:'+file.type+';base64,'+file.data;row.append(player);
      }
      if(handlers.remove){const del=button('Remove',()=>handlers.remove(file));del.setAttribute('aria-label',translate('Remove')+' '+file.name);row.append(del);}
      const metadata=photoMetadata(field,file,handlers.update);
      if(metadata)row.append(metadata);
      list.append(row);
    }
  }
  const isPNG = value => typeof value==='string' && value.startsWith('data:image/png;base64,');
  function sketch(previous) {
    const dialog=el('dialog','modal form-sketch'),title=el('h2','',translate('Draw sketch'));
    title.id='form-sketch-'+ ++sequence;dialog.setAttribute('aria-labelledby',title.id);
    const canvas=el('canvas');canvas.width=800;canvas.height=450;canvas.setAttribute('aria-label',translate('Sketch drawing area'));
    const ctx=canvas.getContext('2d');ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=3;
    let pointer=null,ink=false,revision=0;
    if(isPNG(previous)){const image=new Image();image.onload=()=>{if(!revision){ctx.drawImage(image,0,0,800,450);ink=true;}};image.src=previous;}
    const point=e=>{const b=canvas.getBoundingClientRect();return [(e.clientX-b.left)*800/b.width,(e.clientY-b.top)*450/b.height];};
    canvas.addEventListener('pointerdown',e=>{if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;canvas.setPointerCapture(pointer);revision++;ink=true;
      const [x,y]=point(e);ctx.beginPath();ctx.arc(x,y,1.5,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(x,y);});
    canvas.addEventListener('pointermove',e=>{if(e.pointerId===pointer){ctx.lineTo(...point(e));ctx.stroke();}});
    canvas.addEventListener('lostpointercapture',()=>{pointer=null;});
    const actions=el('div','actions');
    actions.append(button('Clear',()=>{revision++;ctx.clearRect(0,0,800,450);ink=false;}),button('Cancel',()=>dialog.close()),button('Use sketch',()=>{if(ink)dialog.close('save');}));
    dialog.append(title,canvas,actions);document.body.append(dialog);
    return new Promise(resolve=>{dialog.addEventListener('close',()=>{const data=dialog.returnValue==='save'?canvas.toDataURL('image/png'):null;dialog.remove();resolve(data);},{once:true});dialog.showModal();});
  }
  window.ClassifireFormFields = Object.freeze({mount});
})();
