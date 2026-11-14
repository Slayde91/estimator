(() => {
  "use strict";
  const root = document.getElementById('passive-register-root');
  const phases = {before:'Before Photo', during:'During Photo', after:'After Photo', label:'Label Photo'};
  let libraryPicker, pickerEntry;
  let nextNumber = 1;
  const sideId = (number, side) => String(number).padStart(3,'0') + (side === 2 ? '-2' : '');
  const newSide = (id) => ({id_number:id, before:[], during:[], after:[], label:[]});
  const newEntry = () => ({entry_id:crypto.randomUUID(),number:nextNumber,
    location:'', technical_item_id:'', side1:newSide(sideId(nextNumber,1)), side2:newSide(sideId(nextNumber,2)),
    access:'', photos:[], comments:'', solution:'', signature:null});
  let entries = [], current = 0, placeholder = newEntry(), revision = 0, saved = 0;
  let options, pending = false, exporting = false, hasRegister = false, message = '', entrySelect, removeEntry, exportButton;
  const photoPixels = new Map();
  let fieldIndex = 0;
  const editedEntry = () => entries[current] || placeholder;
  function changed() {
    if (!entries.length) { entries.push(placeholder); nextNumber++; }
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
    } else control.maxLength = key === 'comments' ? 4000 : 1000;
    control.value = record[key];
    control.addEventListener(values ? 'change' : 'input', () => {
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
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
      if (!jpeg || jpeg.size > 1024 * 1024) throw new Error('The register photo limit has been reached.');
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(jpeg);
      });
      return {url, pixels:canvas.width * canvas.height};
    } finally { bitmap.close(); }
  }
  async function photoTotals() {
    const total = {encoded:0, pixels:0};
    for (const entry of entries) {
      for (const group of photoGroups(entry)) {
        for (const url of group) {
          if (!photoPixels.has(url)) {
            const image = new Image();
            image.src = url;
            await image.decode();
            photoPixels.set(url, image.naturalWidth * image.naturalHeight);
          }
          total.encoded += url.length;
          total.pixels += photoPixels.get(url);
        }
      }
    }
    return total;
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
        const total = await photoTotals();
        for (const file of files) {
          const photo = await readPhoto(file);
          total.encoded += photo.url.length;
          total.pixels += photo.pixels;
          if (total.encoded > 10 * 1024 * 1024 || total.pixels > 128_000_000)
            throw new Error('The register photo limit has been reached.');
          added.push(photo);
        }
        if (entry === editedEntry()) {
          for (const {url, pixels} of added) {
            record[key].push(url);
            photoPixels.set(url, pixels);
          }
          changed();
        }
        message = '';
      } catch(error) { message = error.message; }
      finally { pending = false; render(); }
    });
    group.append(field(label, input));
    record[key].forEach((url, index) => {
      const figure = el('figure'), img = el('img');
      img.src = url; img.alt = label + ' ' + (index + 1); img.loading = 'lazy';
      figure.append(img, action('Remove photo', () => {
        record[key].splice(index,1); photoPixels.delete(url); changed(); render();
      }));
      group.append(figure);
    });
    return group;
  }
  function photoGroups(entry) {
    return [entry.photos,...[entry.side1,entry.side2].flatMap(side => Object.keys(phases).map(key => side[key]))];
  }
  function sideSection(record, title) {
    const card = el('section','card');
    const number = el('input');
    number.name = 'id_number'; number.readOnly = true; number.value = record.id_number;
    card.append(el('h2','',title),field('ID Number',number));
    if (record.previous_id) {
      const previous = el('p','helper');
      previous.textContent = window.CeasefireI18n.translate('Previous ID') + ' · ' + record.previous_id;
      card.append(previous);
    }
    const grid = el('div','register-grid');
    for (const [key,label] of Object.entries(phases)) grid.append(photoList(record,key,label));
    card.append(grid);
    return card;
  }
  async function download(button) {
    if (pending || exporting) return;
    if (!entries.length) { setStatus(window.CeasefireI18n.translate('Entry {0} is incomplete.', [1])); return; }
    const snapshot = capture().value;
    exporting = true;
    button.disabled = true;
    try {
      const result = await window.CeasefireDownloads.save('/api/project/passive-fire-register.pdf',
        {register:snapshot, project_details:window.CeasefireProject.details(),
          ...window.ClassifireRegisterPlans?.exportContext(snapshot)}, {button});
      if (result?.saved) setStatus('Document saved. Its revision is available in this project.');
    } catch(error) { setStatus(error.message); }
    finally { exporting = false; exportButton.disabled = false; }
  }
  function render() {
    if (!root || !options) return false;
    fieldIndex = 0;
    const entry = editedEntry(), form = el('fieldset','register-form');
    form.disabled = pending;
    const toolbar = el('div','register-toolbar card');
    entrySelect = el('select');
    entrySelect.addEventListener('change', () => { current = Number(entrySelect.value); message = ''; render(); });
    refreshEntryList();
    const add = action('Add entry', () => {
      entries.push(newEntry()); nextNumber++; current = entries.length - 1; changed(); message = ''; render();
    });
    add.disabled = entries.length >= 200;
    const remove = action('Remove entry', async () => {
      if (!entries.length || !await window.CeasefireDialogs.confirm('Remove this register entry?', 'Remove entry and its photos?', 'Remove entry')) return;
      if (entry !== editedEntry()) return;
      entries.splice(current,1);
      for (const group of photoGroups(entry)) for (const url of group) photoPixels.delete(url);
      current = Math.max(0, current - 1);
      placeholder = newEntry();
      hasRegister = true; revision++; window.CeasefireProject.changed(); message = ''; render();
    });
    remove.disabled = !entries.length;
    removeEntry = remove;
    exportButton = action('Download PDF', e => download(e.currentTarget), 'primary');
    exportButton.disabled = exporting;
    toolbar.append(field('Register entry',entrySelect), add, remove, exportButton);
    const status = el('p','helper',message);
    status.setAttribute('role','status');
    if (pickerEntry !== entry) {
      libraryPicker?.close();
      libraryPicker = window.ClassifireRegisterLibrary.picker(entry, changed);
      pickerEntry = entry;
    }
    const card = el('section','card');
    card.append(editor(entry,'location','Level/Location'));
    form.append(toolbar, status, card, libraryPicker.element, sideSection(entry.side1,'Side 1'));
    const access = el('section','card');
    access.append(editor(entry,'access','Is the other side accessible?',options.access,true));
    if (entry.access === 'No') access.append(photoList(entry,'photos','Photos'), editor(entry,'comments','Comments'));
    if (entry.access === 'NA') access.append(editor(entry,'solution','Solution',options.solution));
    form.append(access);
    if (entry.access === 'Yes') form.append(sideSection(entry.side2,'Side 2'));
    if (window.ClassifireRegisterPlans) {
      form.append(window.ClassifireRegisterPlans.section({entry, entries, changed, el, field}));
    }
    const sign = el('section','card');
    sign.append(el('h2','','Signature'));
    if (entry.signature) {
      const img = el('img','register-signature'); img.alt = 'Signature';
      img.src = window.ClassifirePersonalSignature.png(entry.signature);
      sign.append(img);
    }
    sign.append(window.ClassifireFormControls.iconButton('Insert signature', 'signature', async () => {
      try {
        const value = await window.ClassifirePersonalSignature.choose(entry.signature);
        if (value && editedEntry() === entry) { entry.signature = value; changed(); render(); }
      } catch(error) { setStatus(error.message); }
    }));
    if (entry.signature) sign.append(action('Clear signature', () => { entry.signature = null; changed(); render(); }));
    form.append(sign, el('p','helper','Save the project to keep this register.'));
    root.replaceChildren(form);
    return true;
  }
  function capture() {
    if (pending) throw new Error('Finish adding photos before continuing.');
    return {revision, value:hasRegister ? {entries:structuredClone(entries),next_number:nextNumber} : null};
  }
  window.ClassifirePassiveRegister = {
    setOptions(value) { options = value; },
    open:render, capture, revision:() => revision, busy:() => pending,
    hasProjectChanges:() => saved !== revision,
    markSaved(snapshot) { if (snapshot?.revision === revision) saved = revision; },
    applyProject(snapshot) {
      window.ClassifireRegisterPlans?.close();
      libraryPicker?.close(); libraryPicker = null; pickerEntry = null;
      photoPixels.clear();
      entries = structuredClone(snapshot?.entries || []);
      nextNumber = snapshot?.next_number ?? entries.length+1;
      if (snapshot && snapshot.next_number == null) entries.forEach((entry,i) => {
        entry.number = i+1;
        entry.entry_id = '00000000-0000-5000-8000-'+entry.number.toString(16).padStart(12,'0');
        for (const side of [1,2]) {
          const record = entry['side'+side], id = sideId(entry.number,side);
          if (record.id_number && record.id_number !== id) record.previous_id = record.id_number;
          record.id_number = id;
        }
      });
      current = 0; placeholder = newEntry(); message = ''; hasRegister = Boolean(snapshot);
      saved = ++revision;
      if (root?.closest('.view')?.hidden === false) render();
      else root?.replaceChildren();
    }
  };
})();
