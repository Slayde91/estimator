(() => {
  "use strict";
  const root = document.getElementById('passive-register-root');
  const phases = {before:'Before Photo', during:'During Photo', after:'After Photo', label:'Label Photo'};
  let libraryPicker, pickerEntry;
  const legacyLabels = new Map();
  let labelRequest;
  let nextNumber = 1;
  const sideId = (number, side) => String(number).padStart(3,'0') + (side === 2 ? '-2' : '');
  const penetrationIds = entry => entry.side1.id_number + (entry.access === 'Yes' ? ' / ' + entry.side2.id_number : '');
  const newSide = (id) => ({id_number:id, before:[], during:[], after:[], label:[]});
  const newEntry = () => ({entry_id:crypto.randomUUID(),number:nextNumber,
    location:'', technical_item_id:'', technical_filters:window.ClassifireRegisterLibrary.emptyFilters(),
    side1:newSide(sideId(nextNumber,1)), side2:newSide(sideId(nextNumber,2)),
    access:'', photos:[], comments:'', solution:'', signature:null});
  let entries = [], current = 0, placeholder = newEntry(), revision = 0, saved = 0;
  let options, pending = false, exporting = false, hasRegister = false, message = '', entrySelect;
  const photoPixels = new Map();
  let fieldIndex = 0;
  const editedEntry = () => entries[current] || placeholder;
  function changed() {
    if (!entries.length) { entries.push(placeholder); nextNumber++; }
    hasRegister = true;
    revision++;
    window.CeasefireProject.changed();
    for (const button of root.querySelectorAll('[data-register-action="remove"]')) button.disabled = false;
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
      const filters = entry.technical_filters || {};
      const source = legacyLabels.get(entry.technical_item_id) || {};
      const ids = penetrationIds(entry);
      const parts = [entry.location, filters.substrate || entry.substrate || source.substrate, filters.category || source.category,
        filters.services || entry.service_types?.join(', ') || source.services, filters.frl || entry.frl || source.frl];
      option.textContent = ids + ': ' + parts.map(value => value?.trim() || '—').join('-');
      option.value = String(index);
      return option;
    }));
    entrySelect.value = String(current);
  }
  async function loadLegacyLabels() {
    if (labelRequest) return;
    const ids = [...new Set(entries.filter(entry => entry.technical_item_id && !entry.technical_filters?.services)
      .map(entry => entry.technical_item_id).filter(id => !legacyLabels.has(id)))];
    if (!ids.length) return;
    const request = new AbortController();
    labelRequest = request;
    try {
      const response = await fetch('/api/libraries/inspection-labels', {method:'POST', signal:request.signal,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids})});
      if (!response.ok) return;
      const labels = await response.json();
      if (request.signal.aborted) return;
      for (const id of ids) legacyLabels.set(id, labels[id]);
      refreshEntryList();
    } catch {
      // The register remains editable with its saved values when the library is unavailable.
    } finally {
      if (labelRequest === request) labelRequest = null;
    }
  }
  function field(label, control) {
    const wrap = el('label','field');
    const caption = el('span','',label);
    caption.id = 'passive-register-label-' + (++fieldIndex);
    control.setAttribute('aria-labelledby',caption.id);
    wrap.append(caption, control);
    return wrap;
  }
  async function signatureDetails(memberId) {
    const [profileResponse, sessionResponse] = await Promise.all([
      fetch('/api/forms/signer', {cache:'no-store'}),
      fetch('/api/scheduler/bootstrap', {cache:'no-store'})
    ]);
    if (!profileResponse.ok || !sessionResponse.ok) throw new Error('Personal details could not be loaded. Try again.');
    const [profile, session] = await Promise.all([profileResponse.json(), sessionResponse.json()]);
    if (!memberId || profile.id !== memberId || session.user?.id !== memberId || window.ClassifireAccess.user?.id !== memberId)
      throw new Error('Your signature profile changed. Reopen the signature pad.');
    if (!profile.name?.trim() || !profile.at || !session.timezone) throw new Error('Personal details could not be loaded. Try again.');
    const date = window.ClassifireDates.parseDate(window.ClassifireDates.date(profile.at, {timeZone:session.timezone}));
    if (!date) throw new Error('Personal details could not be loaded. Try again.');
    return {member_id:memberId, name:profile.name, date};
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
    control.value = record[key] || '';
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
  function customFields(entry) {
    const grid = el('div','register-grid');
    const report = editor(entry, 'report', 'Report/Assessment');
    const input = report.querySelector('input');
    const list = el('datalist');
    list.id = 'register-manual-reports';
    input.setAttribute('list', list.id);
    report.append(list);
    grid.append(report);
    const group = el('fieldset','register-choices');
    group.append(el('legend','','Products'));
    for (const value of options.products) {
      const wrap = el('label'), check = el('input');
      check.type = 'checkbox';
      check.value = value;
      check.checked = (entry.products || []).includes(value);
      check.addEventListener('change', () => {
        entry.products = Array.from(group.querySelectorAll('input:checked'), node => node.value);
        changed();
      });
      wrap.append(check, document.createTextNode(value));
      group.append(wrap);
    }
    return [grid, group];
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
      figure.append(img, window.ClassifireFormControls.iconButton('Remove photo', 'remove', () => {
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
    if (!entries.length) { setStatus(window.CeasefireI18n.translate('Entry {0} is incomplete.', [penetrationIds(editedEntry())])); return; }
    const snapshot = capture().value;
    exporting = true;
    for (const control of root.querySelectorAll('[data-register-action="pdf"]')) control.disabled = true;
    try {
      const result = await window.CeasefireDownloads.save('/api/project/passive-fire-register.pdf',
        {register:snapshot, project_details:window.CeasefireProject.details(),
          ...window.ClassifireRegisterPlans?.exportContext(snapshot)}, {button});
      if (result?.saved) {
        setStatus('');
        window.CeasefireDialogs.message({i18nSource:'File saved to {0}.{1}', i18nArgs:[result.path, '']});
      }
    } catch(error) { setStatus(error.message); }
    finally {
      exporting = false;
      for (const control of root.querySelectorAll('[data-register-action="pdf"]')) control.disabled = false;
    }
  }
  function entryActions(entry) {
    const {iconButton} = window.ClassifireFormControls;
    const back = iconButton('Back', 'back', () => window.CeasefireProject.openDocumentation());
    const add = iconButton('Add entry', 'add', () => {
      entries.push(newEntry()); nextNumber++; current = entries.length - 1; changed(); message = ''; render();
    });
    add.disabled = entries.length >= 200;
    const remove = iconButton('Remove entry', 'remove', async () => {
      if (!entries.length || !await window.CeasefireDialogs.confirm('Remove this register entry?', 'Remove entry and its photos?', 'Remove entry')) return;
      if (entry !== editedEntry()) return;
      entries.splice(current,1);
      for (const group of photoGroups(entry)) for (const url of group) photoPixels.delete(url);
      current = Math.max(0, current - 1);
      placeholder = newEntry();
      hasRegister = true; revision++; window.CeasefireProject.changed(); message = ''; render();
    });
    remove.disabled = !entries.length;
    remove.dataset.registerAction = 'remove';
    const exportButton = iconButton('Download PDF', 'pdf', e => download(e.currentTarget));
    exportButton.dataset.registerAction = 'pdf';
    exportButton.disabled = exporting;
    return [back, add, remove, exportButton];
  }
  function render() {
    if (!root || !options) return false;
    fieldIndex = 0;
    const entry = editedEntry(), form = el('fieldset','register-form');
    form.disabled = pending;
    const toolbar = el('div','register-toolbar register-actions card');
    entrySelect = el('select');
    entrySelect.addEventListener('change', () => { current = Number(entrySelect.value); message = ''; render(); });
    refreshEntryList();
    loadLegacyLabels();
    toolbar.append(field('Register entry',entrySelect), ...entryActions(entry));
    const status = el('p','helper',message);
    status.setAttribute('role','status');
    if (pickerEntry !== entry) {
      libraryPicker?.close();
      libraryPicker = window.ClassifireRegisterLibrary.picker(entry, changed, options, customFields);
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
    const signer = el('div','register-grid');
    const details = entry.signature_details;
    for (const [label, value] of [['Name', details?.name || ''], ['Date', details ? window.ClassifireDates.date(details.date) : '']]) {
      const input = el('input');
      input.readOnly = true;
      input.value = value;
      signer.append(field(label, input));
    }
    sign.append(signer);
    if (entry.signature) {
      const img = el('img','register-signature'); img.alt = 'Signature';
      img.src = window.ClassifirePersonalSignature.png(entry.signature);
      sign.append(img);
    }
    const buttons = el('div','register-signature-actions');
    buttons.append(window.ClassifireFormControls.iconButton('Insert signature', 'signature', async event => {
      const button = event.currentTarget;
      const memberId = window.ClassifireAccess.user?.id;
      button.disabled = true;
      try {
        const value = await window.ClassifirePersonalSignature.choose(entry.signature);
        if (!value) return;
        const details = await signatureDetails(memberId);
        if (button.isConnected && !root.closest('.view')?.hidden && editedEntry() === entry) {
          entry.signature = value;
          entry.signature_details = details;
          changed();
          render();
        }
      } catch(error) {
        if (button.isConnected) setStatus(error.message);
      } finally {
        button.disabled = false;
      }
    }));
    if (entry.signature) {
      const clear = action('', () => {
        entry.signature = null;
        delete entry.signature_details;
        changed();
        render();
      });
      clear.classList.add('icon-only','form-control-icon');
      for (const attr of ['title', 'aria-label']) window.CeasefireI18n.attr(clear, attr, 'Clear signature');
      const artwork = document.querySelector('#penetration-clear svg').cloneNode(true);
      artwork.setAttribute('aria-hidden','true');
      artwork.setAttribute('focusable','false');
      clear.append(artwork);
      buttons.append(clear);
    }
    sign.append(buttons);
    const footer = el('div','register-footer-actions register-actions');
    footer.append(...entryActions(entry));
    form.append(sign, el('p','helper','Save the project to keep this register.'), footer);
    root.replaceChildren(form);
    return true;
  }
  function capture() {
    if (pending) throw new Error('Finish adding photos before continuing.');
    return {revision, value:hasRegister ? {entries:structuredClone(entries),next_number:nextNumber} : null};
  }
  window.ClassifirePassiveRegister = {
    penetrationIds,
    setOptions(value) { options = value; },
    open:render, capture, revision:() => revision, busy:() => pending,
    hasProjectChanges:() => saved !== revision,
    markSaved(snapshot) { if (snapshot?.revision === revision) saved = revision; },
    applyProject(snapshot) {
      labelRequest?.abort(); labelRequest = null; legacyLabels.clear();
      window.ClassifireRegisterPlans?.close();
      libraryPicker?.close(); libraryPicker = null; pickerEntry = null;
      photoPixels.clear();
      entries = structuredClone(snapshot?.entries || []);
      for (const {technical_filters} of entries) {
        if (['HVAC','Mechanical'].includes(technical_filters?.category)) technical_filters.category = 'HVAC & Mechanical';
      }
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
