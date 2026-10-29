(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('certification-form');
  if (!form) return;
  const fieldNames = ['client', 'project', 'address', 'location_area', 'statement_of_compliance',
    'australian_standards', 'ncc_clauses', 'approved_design', 'additional_standards',
    'other_references', 'exclusions', 'materials_manufacturers', 'fire_resistance_level',
    'name', 'position', 'qualification', 'accreditation'];
  const controls = Object.fromEntries(fieldNames.map(name => [name, $('certification-' + name)]));
  const selector = $('certification-document'), saveButton = $('certification-save'), generateButton = $('certification-generate');
  const state = { id: null, version: null, baseline: '', busy: false, pending: null, loaded: false,
    items: [], listRevision: 0, companyName: '', opening: null, conflicted: false };
  const copy = value => JSON.parse(JSON.stringify(value));
  const capture = () => Object.fromEntries(fieldNames.map(name => [name, controls[name].value]));
  const stamp = fields => JSON.stringify(fieldNames.map(name => fields[name] || ''));
  state.baseline = stamp(capture());
  function text(element, source, args = []) {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = source.replace(/\{(\d+)\}/g, (_, n) => args[n] ?? ''); return element;
  }
  function node(tag, value) { const item = document.createElement(tag); if (value !== undefined) item.textContent = String(value); return item; }
  function message(source, error = false) {
    text($('certification-status'), source);
    $('certification-status').className = error ? 'message error certification-save-status' : 'helper certification-save-status';
  }
  function dirty() { return state.conflicted || stamp(capture()) !== state.baseline; }
  function updateControls() {
    const locked = !state.loaded || !!state.opening || state.busy || !!state.pending;
    for (const control of Object.values(controls)) control.disabled = locked;
    selector.disabled = locked;
    $('certification-new').disabled = locked;
    $('certification-reload').disabled = locked || !state.id;
    saveButton.disabled = !state.loaded || !!state.opening || state.busy || (!!state.pending && state.pending.kind !== 'save');
    generateButton.disabled = !state.loaded || !!state.opening || state.busy || (!!state.pending && state.pending.kind !== 'generate');
    form.setAttribute('aria-busy', String(state.busy || !!state.opening));
  }
  function companyText(name) {
    state.companyName = name;
    text($('certification-exclusions-intro'),
      'Certification is strictly limited to passive fire protection works completed by {0}, in accordance with:', [name]);
    text($('certification-declaration'),
      '{0} are approved by the manufacturers listed above to supply and install passive fire products in accordance with tested and certified systems. I am a properly qualified person and have a good working knowledge of the relevant codes and standards referenced above. The information contained in this statement is true and accurate to the best of my knowledge.', [name]);
  }
  async function request(path, options = {}) {
    const response = await fetch(path, options);
    let result;
    try { result = await response.json(); }
    catch { const error = new Error('The operation result could not be confirmed. Retry the same operation.'); error.uncertain = true; throw error; }
    if (!response.ok) {
      const error = new Error(result.error || 'Certification details could not be saved.');
      error.status = response.status; error.uncertain = response.status >= 500; throw error;
    }
    return result;
  }
  const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const uuid = () => window.crypto.randomUUID();
  function label(item) {
    const fields = item.fields || item;
    return [fields.project, fields.client, fields.address].filter(Boolean).join(' · ') || 'Certificate ' + item.id.slice(0, 8);
  }
  function renderDocuments() {
    const empty = node('option'); empty.value = ''; text(empty, 'New certificate');
    selector.replaceChildren(empty, ...state.items.map(item => {
      const option = node('option', label(item)); option.value = item.id; return option;
    }));
    selector.value = state.id || '';
  }
  function renderRevisions(revisions) {
    const host = $('certification-revisions');
    if (!revisions.length) { const empty = node('p'); text(empty, 'No certificates have been generated yet.'); host.replaceChildren(empty); return; }
    const table = node('table'), head = node('thead'), headings = node('tr'), body = node('tbody');
    for (const source of ['Revision', 'Generated', 'Certificate']) { const cell = node('th'); cell.scope = 'col'; text(cell, source); headings.append(cell); }
    head.append(headings);
    for (const revision of [...revisions].sort((a, b) => b.revision - a.revision)) {
      const row = node('tr'), number = node('td', revision.revision);
      const date = new Date(revision.created_at), when = node('td', Number.isNaN(date.getTime()) ? revision.created_at : date.toLocaleString('en-AU'));
      const cell = node('td'), link = node('a');
      // Link only to this document's immutable, server-owned PDF endpoint.
      const expected = '/api/certifications/' + encodeURIComponent(state.id) + '/revisions/' + revision.revision + '.pdf';
      if (!Number.isInteger(revision.revision) || revision.revision < 1 || revision.pdf_url !== expected) throw new Error('The saved certificate link is invalid.');
      link.href = expected; link.target = '_blank'; link.rel = 'noopener';
      text(link, 'Open revision {0}', [revision.revision]); cell.append(link); row.append(number, when, cell); body.append(row);
    }
    table.append(head, body); host.replaceChildren(table);
  }
  function applyDocument(document) {
    ++state.listRevision;
    state.id = document.id; state.version = document.version;
    state.conflicted = false;
    for (const name of fieldNames) controls[name].value = document.fields[name] || '';
    state.baseline = stamp(capture());
    const index = state.items.findIndex(item => item.id === document.id);
    if (index < 0) state.items.unshift(document); else state.items[index] = document;
    renderDocuments(); renderRevisions(document.revisions || []);
  }
  async function confirmDiscard() {
    if (!dirty()) return true;
    const captured = stamp(capture()), id = state.id;
    const accepted = await window.CeasefireDialogs.confirm('Unsaved certification details',
      'Continue without saving these certification details?', 'Continue without saving', 'Keep editing');
    if (!accepted) return false;
    if (captured !== stamp(capture()) || id !== state.id || state.busy || state.pending) {
      message('Certification details changed during the confirmation. Review the current fields first.', true); return false;
    }
    return true;
  }
  function freshFields() {
    for (const name of fieldNames) controls[name].value = '';
    const project = window.CeasefireProject?.details?.();
    if (project) {
      controls.client.value = project.client || '';
      controls.project.value = project.project_no || '';
      controls.address.value = project.site_address || '';
    }
    state.id = state.version = null; state.conflicted = false; state.baseline = stamp(Object.fromEntries(fieldNames.map(name => [name, ''])));
    renderDocuments(); renderRevisions([]); updateControls();
    message(dirty() ? 'Unsaved certification details' : 'Enter the certification details.');
  }
  async function loadDocument(id, { force = false } = {}) {
    if (state.busy || state.pending || (state.opening && !force) || (!force && !await confirmDiscard())) { selector.value = state.id || ''; return; }
    if (state.busy || state.pending || (state.opening && !force)) { selector.value = state.id || ''; return; }
    if (!id) { freshFields(); return; }
    state.busy = true; updateControls(); message('Loading certification…');
    try {
      const document = await request('/api/certifications/' + encodeURIComponent(id));
      applyDocument(document); message('Saved certification details');
    } catch (error) { selector.value = state.id || ''; message(error.message, true); }
    finally { state.busy = false; updateControls(); }
  }
  async function loadList() {
    const revision = ++state.listRevision;
    const data = await request('/api/certifications');
    if (revision !== state.listRevision) return;
    state.items = data.items || []; renderDocuments();
  }
  async function open() {
    if (state.opening) return state.opening;
    message('Loading certification…');
    state.opening = (async () => {
      const company = await request('/api/company-settings');
      companyText(company.name);
      if (!state.loaded) {
        await loadList(); state.loaded = true;
        if (!state.id && !dirty() && state.items.length) await loadDocument(state.items[0].id, { force: true });
        else if (!state.id && !dirty()) freshFields();
      } else await loadList();
      updateControls();
    })();
    updateControls();
    try { return await state.opening; } finally { state.opening = null; updateControls(); }
  }
  async function perform(kind) {
    if (!state.loaded || state.opening || state.busy || (state.pending && state.pending.kind !== kind)) return;
    if (!form.reportValidity()) return;
    const action = state.pending || { kind, fields: copy(capture()), id: state.id, version: state.version,
      createRequestId: uuid(), generationRequestId: uuid() };
    state.pending = action; state.busy = true; updateControls();
    message(kind === 'generate' ? 'Generating and saving certificate revision…' : 'Saving certification details…');
    const endActivity = window.CeasefireActivity?.begin();
    try {
      if (!action.id) {
        const created = await post('/api/certifications', { fields: action.fields, request_id: action.createRequestId });
        action.id = created.id; action.version = created.version;
        // Capture identity before the next request. A failed generation retry
        // must return to this document and exactly the same request ID.
        applyDocument(created);
        if (kind === 'save') { state.pending = null; message('Certification details saved.'); return; }
      }
      if (kind === 'save') {
        const saved = await post('/api/certifications/' + encodeURIComponent(action.id),
          { fields: action.fields, expected_version: action.version });
        state.pending = null; applyDocument(saved); message('Certification details saved.');
      } else {
        const saved = await post('/api/certifications/' + encodeURIComponent(action.id) + '/revisions',
          { fields: action.fields, expected_version: action.version, request_id: action.generationRequestId });
        state.pending = null; applyDocument(saved.document);
        text($('certification-status'), 'Revision {0} saved. Open it in Certificate revisions.', [saved.revision.revision]);
        $('certification-status').className = 'helper certification-save-status';
      }
    } catch (error) {
      if (error.status && !error.uncertain) state.pending = null;
      if (error.status === 409) state.conflicted = true;
      message(state.pending ? 'The operation result could not be confirmed. Retry the same button to recover it without creating another revision.' : error.message, true);
    } finally { state.busy = false; updateControls(); endActivity?.(); }
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => { if (!state.busy && !state.pending) message(dirty() ? 'Unsaved certification details' : 'Saved certification details'); });
  saveButton.addEventListener('click', () => perform('save'));
  generateButton.addEventListener('click', event => { if (!(event.detail > 1)) return perform('generate'); });
  selector.addEventListener('change', () => loadDocument(selector.value));
  $('certification-new').addEventListener('click', async () => { if (state.loaded && !state.opening && !state.busy && !state.pending && await confirmDiscard() && !state.opening && !state.busy && !state.pending) freshFields(); });
  $('certification-reload').addEventListener('click', () => { if (state.id) loadDocument(state.id); });
  window.addEventListener('ceasefire:company-settings-saved', event => { if (typeof event.detail?.name === 'string') companyText(event.detail.name); });
  window.CeasefireCertification = { open, hasUnsavedChanges: () => dirty() || !!state.pending,
    hasPendingOperation: () => !!state.opening || state.busy || !!state.pending,
    fingerprint: () => JSON.stringify({ id: state.id, version: state.version, fields: capture(), pending: state.pending }) };
  renderRevisions([]); updateControls();
})();
