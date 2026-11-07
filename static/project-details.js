(() => {
  'use strict';
  const text = (element, value, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, value, args);
    element.textContent = String(value).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
    return element;
  };
  const client = document.getElementById('client');
  const form = document.getElementById('document-number-settings');
  if (!client || !form) return;
  const choices = document.createElement('datalist');
  choices.id = 'previous-project-clients'; client.setAttribute('list', choices.id); client.after(choices);
  const historyStatus = document.createElement('span'); historyStatus.className = 'helper'; historyStatus.hidden = true;
  historyStatus.setAttribute('role', 'status'); choices.after(historyStatus);
  const status = document.getElementById('project-details-settings-status');
  const next = document.getElementById('project-number-next');
  const prefix = document.getElementById('project-number-prefix');
  const start = document.getElementById('project-start-number');
  let scanning = null, current = null, saving = false, settingsGeneration = 0;
  const requests = new Map();
  async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Project details could not be loaded.');
    return body;
  }
  function message(value, error = false) {
    text(status, value); status.className = error ? 'message error' : 'status-label calculator-status';
    window.CeasefireNotifications?.show(status);
  }
  function render(value) {
    current = value; prefix.value = value.prefix; start.value = value.start_number;
    next.textContent = value.next_reference;
  }
  function clients() {
    if (scanning) return scanning;
    scanning = (async () => {
      let result;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await request('/api/project-clients');
        const options = result.clients.map(value => { const option = document.createElement('option'); option.value = value; return option; });
        choices.replaceChildren(...options);
        historyStatus.hidden = !result.scan_pending && !result.error_count;
        if (result.error_count) text(historyStatus, 'Some saved projects could not be read. Check the Projects page for details.');
        else if (result.scan_pending) text(historyStatus, 'Loading previous clients…');
        if (!result.scan_pending) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return result;
    })().catch(error => {
      historyStatus.hidden = false; text(historyStatus, error.message); throw error;
    }).finally(() => { scanning = null; });
    return scanning;
  }
  client.addEventListener('focus', () => { void clients().catch(() => {}); });
  window.CeasefireProjectDetails = Object.freeze({
    async prepareSave(context) {
      const result = await clients();
      if (result.scan_pending) throw new Error('The project folder is still being read. Wait for the previous clients to finish loading and save again.');
      if (result.error_count) throw new Error('Resolve unreadable project files in the linked folder before assigning a new project number.');
      if (!requests.has(context)) requests.set(context, crypto.randomUUID());
      return requests.get(context);
    },
    saved(context) {
      requests.delete(context);
      void clients().catch(() => {});
      const generation = settingsGeneration;
      if (!saving && current && !numberDirty) void request('/api/project-details').then(value => {
        if (generation === settingsGeneration && !saving && prefix.value === current.prefix && Number(start.value) === current.start_number) render(value);
      }).catch(() => {});
    },
  });
  const numberForm = form;
  const labels = {quote:'Quotes', work_order:'Work Orders', purchase_order:'Purchase Orders', swms:'SWMS', certification:'Certification'};
  const fields = new Map();
  let numberDirty = false, numberGeneration = 0;
  function controlsDisabled(value) { for (const control of form.elements) control.disabled = value; }
  function renderNumbers(settings) {
    // Keep the static Projects row and its established input identities.
    for (const row of numberForm.querySelectorAll('tbody tr[data-document-kind]')) row.remove();
    fields.clear();
    for (const [kind, label] of Object.entries(labels)) {
      const row = numberForm.querySelector('tbody').insertRow(); row.dataset.documentKind = kind;
      row.insertCell().textContent = label;
      const p = document.createElement('input'), s = document.createElement('input');
      p.maxLength = 12; p.pattern = '[A-Za-z]{1,12}'; p.required = true; p.value = settings[kind].prefix;
      s.type = 'number'; s.min = 1; s.max = 9999999999; s.step = 1; s.required = true; s.value = settings[kind].start_number;
      p.setAttribute('aria-label', label + ' prefix'); s.setAttribute('aria-label', label + ' starting number');
      row.insertCell().append(p); row.insertCell().append(s);
      const reference = row.insertCell();
      if (settings[kind].exhausted) text(reference, 'Sequence exhausted. Choose another prefix.');
      else reference.textContent = settings[kind].next_reference;
      fields.set(kind, {p,s});
    }
  }
  function renderCombined(value) {
    if (!value?.project || !value.documents || Object.keys(labels).some(kind => !value.documents[kind])) throw new Error('Numbering settings could not be loaded.');
    render(value.project); renderNumbers(value.documents);
  }
  numberForm.addEventListener('input', () => { numberDirty = true; numberGeneration++; message('Unsaved changes'); });
  document.getElementById('migrate-order-numbers').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (saving) return;
    button.disabled = true;
    try {
      let result;
      do {
        result = await request('/api/document-numbering/migrate-orders', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
      } while (result.scan_pending);
      text(status, '{0} orders updated in {1} files. {2} files need review.', [result.updated_orders,result.updated_files,result.errors.length+result.unreadable_files]);
    } catch (error) { message(error.message, true); }
    finally { button.disabled = saving || !current; }
  });
  numberForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !current || fields.size !== Object.keys(labels).length || !form.reportValidity()) return;
    const body = {project:{prefix:prefix.value.trim(),start_number:Number(start.value)},
      documents:Object.fromEntries([...fields].map(([kind,{p,s}]) => [kind, {prefix:p.value.trim(),start_number:Number(s.value)}]))};
    saving = true; settingsGeneration++; const generation = ++numberGeneration;
    controlsDisabled(true); const finish = window.CeasefireActivity?.begin();
    try {
      const saved = await request('/api/numbering-settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if (generation === numberGeneration) { renderCombined(saved); numberDirty = false; message('Saved'); }
      else message('Numbering saved. Later edits remain unsaved.');
    } catch (error) { message(error.message, true); }
    finally { saving = false; controlsDisabled(!current); finish?.(); }
  });
  const settingsView = document.getElementById('view-settings');
  async function refreshNumbers() {
    if (saving || numberDirty) return;
    const generation = ++numberGeneration;
    if (!current) controlsDisabled(true);
    try {
      const value = await request('/api/numbering-settings');
      if (generation === numberGeneration && !numberDirty && !saving) { renderCombined(value); message('Saved'); }
    } catch (error) { if (generation === numberGeneration) message(error.message, true); }
    finally { controlsDisabled(saving || !current); }
  }
  new MutationObserver(() => { if (!settingsView.hidden) void refreshNumbers(); }).observe(settingsView, {attributes:true, attributeFilter:['hidden']});
  void clients().catch(() => {}); void refreshNumbers();
})();
