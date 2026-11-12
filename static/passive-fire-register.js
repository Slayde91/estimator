(() => {
  "use strict";
  const root = document.getElementById('passive-register-root');
  const phases = {before:'Before Photo', during:'During Photo', after:'After Photo', label:'Label Photo'};
  const fields = {location:'Level/Location', seal_type:'Seal Type', frl:'FRL', substrate:'Substrate',
    orientation:'Orientation', installation_type:'Installation Type', service_types:'Service Type',
    manufacturer:'Manufacturer', report:'Report/Assessment', products:'Products'};
  const newSide = () => ({id_number:'', before:[], during:[], after:[], label:[]});
  const newEntry = () => ({location:'', seal_type:'', frl:'', substrate:'', orientation:'', installation_type:'',
    service_types:[], manufacturer:'', report:'', products:[], side1:newSide(), side2:newSide(),
    access:'', photos:[], comments:'', solution:'', signature:null});
  let entries = [], current = 0, placeholder = newEntry(), revision = 0, saved = 0;
  let options, pending = false, hasRegister = false, message = '', entrySelect, removeEntry;
  let fieldIndex = 0;
  const editedEntry = () => entries[current] || placeholder;
  function changed() {
    if (!entries.length) entries.push(placeholder);
    hasRegister = true;
    revision++;
    window.CeasefireProject.changed();
    if (removeEntry) removeEntry.disabled = false;
    refreshEntryList();
  }
  function el(tag, className, label, args = []) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (label) window.CeasefireI18n.text(element, label, args);
    return element;
  }
  function action(label, fn, variant = 'secondary') {
    const button = el('button','button ' + variant,label);
    button.type = 'button';
    button.addEventListener('click', fn);
    return button;
  }
  function setStatus(value) {
    message = value;
    const status = root.querySelector('[role="status"]');
    if (status) window.CeasefireI18n.text(status,value);
  }
  function refreshEntryList() {
    if (!entrySelect) return;
    entrySelect.replaceChildren(...(entries.length ? entries : [placeholder]).map((entry, index) => {
      const option = el('option');
      if (entry.location.trim()) option.textContent = (index + 1) + ' · ' + entry.location.trim();
      else window.CeasefireI18n.text(option,'Entry {0}',[index + 1]);
      option.value = String(index);
      return option;
    }));
    entrySelect.value = String(current);
  }
  function field(label, control) {
    const wrap = el('label','field');
    const caption = el('span','',label);
    caption.id = 'passive-register-label-' + (++fieldIndex);
    control.setAttribute('aria-labelledby',caption.id);
    wrap.append(caption, control);
    return wrap;
  }
  function editor(record, key, label, values, rerender = false) {
    const multiple = Array.isArray(record[key]);
    if (multiple) {
      const group = el('fieldset','register-choices');
      group.append(el('legend','',label));
      for (const value of values) {
        const wrapper = el('label'), check = el('input');
        check.type = 'checkbox';
        check.value = value;
        check.checked = record[key].includes(value);
        check.addEventListener('change', () => {
          record[key] = values.filter(item => item === value ? check.checked : record[key].includes(item));
          changed();
        });
        wrapper.append(check, document.createTextNode(value));
        group.append(wrapper);
      }
      return group;
    }
    const control = el(values ? 'select' : key === 'comments' ? 'textarea' : 'input');
    if (values) {
      const blank = el('option','','Select');
      blank.value = '';
      control.append(blank);
      for (const value of values) {
        const option = new Option(value,value);
        if (key === 'access') window.CeasefireI18n.text(option,value);
        control.add(option);
      }
    } else control.maxLength = key === 'comments' ? 4000 : key === 'id_number' ? 200 : 1000;
    control.value = record[key];
    control.addEventListener(values ? 'change' : 'input', () => {
      if (key === 'manufacturer' && record.manufacturer !== control.value) record.report = '';
      record[key] = control.value;
      changed();
      if (rerender) {
        render();
        root.querySelector('[name="' + key + '"]')?.focus();
      }
    });
    control.name = key;
    return field(label,control);
  }
  async function readPhoto(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)
      throw new Error('Select JPEG, PNG or WebP photos up to 20 MB each.');
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
      const canvas = el('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      return canvas.toDataURL('image/jpeg', 0.78);
    } finally { bitmap.close(); }
  }
  function photoList(record, key, label) {
    const group = el('div','register-photo-field'), input = el('input');
    input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.multiple = true;
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length || pending) return;
      const entry = editedEntry();
      pending = true; message = 'Preparing photos…'; render();
      try {
        if (files.length + record[key].length > 20) throw new Error('The register photo limit has been reached.');
        const added = [];
        let bytes = entries.reduce((sum, row) => sum + photoGroups(row).flat().reduce((n, photo) => n + photo.length, 0), 0);
        for (const file of files) {
          const photo = await readPhoto(file);
          bytes += photo.length;
          if (bytes > 10 * 1024 * 1024) throw new Error('The register photo limit has been reached.');
          added.push(photo);
        }
        if (entry === editedEntry()) { record[key].push(...added); changed(); }
        message = '';
      } catch(error) { message = error.message; }
      finally { pending = false; render(); }
    });
    group.append(field(label, input));
    record[key].forEach((url, index) => {
      const figure = el('figure'), img = el('img');
      img.src = url; img.alt = label + ' ' + (index + 1); img.loading = 'lazy';
      figure.append(img, action('Remove photo', () => { record[key].splice(index,1); changed(); render(); }));
      group.append(figure);
    });
    return group;
  }
  function photoGroups(entry) {
    return [entry.photos,...[entry.side1,entry.side2].flatMap(side => Object.keys(phases).map(key => side[key]))];
  }
  function sideSection(record, title) {
    const card = el('section','card');
    card.append(el('h2','',title),editor(record,'id_number','ID Number'));
    const grid = el('div','register-grid');
    for (const [key,label] of Object.entries(phases)) grid.append(photoList(record,key,label));
    card.append(grid);
    return card;
  }
  async function download(button) {
    if (pending) return;
    if (!entries.length) { setStatus(window.CeasefireI18n.translate('Entry {0} is incomplete.', [1])); return; }
    const snapshot = capture().value;
    button.disabled = true;
    try {
      const result = await window.CeasefireDownloads.save('/api/project/passive-fire-register.pdf',
        {register:snapshot, project_details:window.CeasefireProject.details()}, {button});
      if (result?.saved) setStatus('Document saved. Its revision is available in this project.');
    } catch(error) { setStatus(error.message); }
    finally { button.disabled = false; }
  }
  function render() {
    if (!root || !options) return;
    fieldIndex = 0;
    const entry = editedEntry(), form = el('fieldset','register-form');
    form.disabled = pending;
    const toolbar = el('div','register-toolbar card');
    entrySelect = el('select');
    entrySelect.addEventListener('change', () => { current = Number(entrySelect.value); message = ''; render(); });
    refreshEntryList();
    const add = action('Add entry', () => {
      entries.push(newEntry()); current = entries.length - 1; changed(); message = ''; render();
    });
    add.disabled = entries.length >= 200;
    const remove = action('Remove entry', async () => {
      if (!entries.length || !await window.CeasefireDialogs.confirm('Remove this register entry?', 'Remove entry and its photos?', 'Remove entry')) return;
      if (entry !== editedEntry()) return;
      entries.splice(current,1);
      current = Math.max(0, current - 1);
      placeholder = newEntry();
      hasRegister = true; revision++; window.CeasefireProject.changed(); message = ''; render();
    });
    remove.disabled = !entries.length;
    removeEntry = remove;
    const output = action('Download PDF', e => download(e.currentTarget), 'primary');
    toolbar.append(field('Register entry',entrySelect), add, remove, output);
    const status = el('p','helper',message);
    status.setAttribute('role','status');
    const card = el('section','card register-grid');
    for (const [key,label] of Object.entries(fields)) {
      const choices = key === 'report' ? options.reports[entry.manufacturer] : options[key];
      if (key !== 'report' || choices) card.append(editor(entry,key,label,choices,key === 'manufacturer'));
    }
    form.append(toolbar, status, card, sideSection(entry.side1,'Side 1'));
    const access = el('section','card');
    access.append(editor(entry,'access','Is the other side accessible?',options.access,true));
    if (entry.access === 'No') access.append(photoList(entry,'photos','Photos'), editor(entry,'comments','Comments'));
    if (entry.access === 'NA') access.append(editor(entry,'solution','Solution',options.solution));
    form.append(access);
    if (entry.access === 'Yes') form.append(sideSection(entry.side2,'Side 2'));
    const sign = el('section','card');
    sign.append(el('h2','','Signature'));
    if (entry.signature) {
      const img = el('img','register-signature'); img.alt = 'Signature';
      img.src = window.ClassifirePersonalSignature.png(entry.signature);
      sign.append(img);
    }
    sign.append(action('Insert signature', async () => {
      try {
        const value = await window.ClassifirePersonalSignature.choose(entry.signature);
        if (value && editedEntry() === entry) { entry.signature = value; changed(); render(); }
      } catch(error) { setStatus(error.message); }
    }));
    if (entry.signature) sign.append(action('Clear signature', () => { entry.signature = null; changed(); render(); }));
    form.append(sign, el('p','helper','Save the project to keep this register.'));
    root.replaceChildren(form);
  }
  function capture() {
    if (pending) throw new Error('Finish adding photos before continuing.');
    return {revision, value:hasRegister ? {entries:structuredClone(entries)} : null};
  }
  window.ClassifirePassiveRegister = {
    setOptions(value) { options = value; },
    open:render, capture, revision:() => revision, busy:() => pending,
    hasProjectChanges:() => saved !== revision,
    markSaved(snapshot) { if (snapshot?.revision === revision) saved = revision; },
    applyProject(snapshot) {
      entries = structuredClone(snapshot?.entries || []);
      current = 0; placeholder = newEntry(); message = ''; hasRegister = Boolean(snapshot);
      saved = ++revision;
      if (root?.closest('.view')?.hidden === false) render();
      else root?.replaceChildren();
    }
  };
})();
