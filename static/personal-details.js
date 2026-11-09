(() => {
  'use strict';
  const form = document.getElementById('personal-details-form');
  if (!form) return;
  const names = ['name', 'position', 'qualification', 'accreditation'];
  const controls = Object.fromEntries(names.map(name => [name, document.getElementById('personal-' + name)]));
  const status = document.getElementById('personal-details-status');
  const button = document.getElementById('personal-details-save');
  const review = document.getElementById('personal-details-review');
  const preview = document.getElementById('personal-details-previous');
  let current = null, busy = false, conflicted = false, loading = null, generation = 0;
  let previous = null, copiedSignature = null;
  const fields = () => Object.fromEntries(names.map(name => [name, controls[name].value]));
  const stamp = value => JSON.stringify(value);
  const dirty = () => !!current && (conflicted || !!copiedSignature || stamp(fields()) !== stamp(current.fields));
  function valid(value) {
    if (!value || !Number.isInteger(value.version) || value.version < 1 || !value.fields ||
        names.some(name => typeof value.fields[name] !== 'string' || value.fields[name].length > 8000)) {
      throw new Error('The saved personal details could not be confirmed.');
    }
    return {...value, fields:Object.fromEntries(names.map(name => [name, value.fields[name]]))};
  }
  function message(source, error = false) {
    if (window.CeasefireI18n) window.CeasefireI18n.text(status, source);
    else status.textContent = source;
    status.className = error ? 'message error' : 'helper';
    window.CeasefireNotifications?.show(status);
  }
  function lock() {
    for (const control of Object.values(controls)) control.disabled = busy || !current;
    button.disabled = busy || !current;
    if (review) {
      review.hidden = window.ClassifireAccess?.user?.role !== 'admin';
      review.disabled = busy || !current;
    }
    form.setAttribute('aria-busy', String(busy));
  }
  function render(value) {
    current = valid(value); conflicted = false;
    for (const name of names) controls[name].value = value.fields[name];
    lock();
  }
  async function request(options, path = '/api/certifications/defaults') {
    const response = await fetch(path, options);
    let value;
    try { value = await response.json(); }
    catch { throw new Error('Personal details could not be confirmed. Your entries are kept; save again to retry.'); }
    if (!response.ok) {
      const error = new Error(value.error || 'Personal details could not be saved. Your entries are kept.');
      error.status = response.status; throw error;
    }
    return valid(value);
  }
  function closePreview() {
    previous = null;
    const image = document.getElementById('personal-details-previous-image');
    image.removeAttribute('src');
    document.getElementById('personal-details-previous-fields').replaceChildren();
    preview.hidden = true;
  }
  async function reviewPrevious() {
    if (busy || !current || window.ClassifireAccess?.user?.role !== 'admin') return;
    busy = true; lock();
    try {
      closePreview();
      previous = await request({cache:'no-store'}, '/api/certifications/defaults/legacy');
      const list = document.getElementById('personal-details-previous-fields');
      for (const name of names) {
        const title = document.createElement('dt'), value = document.createElement('dd');
        title.textContent = controls[name].closest('label').querySelector('span').textContent;
        value.textContent = previous.fields[name] || '—';
        list.append(title, value);
      }
      const image = document.getElementById('personal-details-previous-image');
      image.hidden = !previous.signature_image;
      if (previous.signature_image) image.src = previous.signature_image;
      document.getElementById('personal-details-use').disabled =
        !previous.signature_image && !Object.values(previous.fields).some(Boolean);
      preview.hidden = false;
    } catch (error) { message(error.message, true); }
    finally { busy = false; lock(); }
  }
  async function usePrevious() {
    if (busy || !previous) return;
    busy = true; lock();
    try {
      const accepted = await window.CeasefireDialogs.confirm('Use these details for my profile',
        'Copy the displayed details into your profile? Choose Save to keep them.', 'Use entered details', 'Cancel');
      if (!accepted) return;
      for (const name of names) controls[name].value = previous.fields[name];
      copiedSignature = previous.signature_image ? {signature_image:previous.signature_image, signature_name:previous.signature_name} : null;
      generation++; closePreview(); message(dirty() ? 'Unsaved changes' : 'Saved');
    } catch (error) { message(error.message, true); }
    finally { busy = false; lock(); }
  }
  if (review && preview) {
    review.addEventListener('click', reviewPrevious);
    document.getElementById('personal-details-use').addEventListener('click', usePrevious);
    document.getElementById('personal-details-close').addEventListener('click', closePreview);
    window.ClassifireAccess?.ready.then(lock);
  }
  async function refresh() {
    if (busy || dirty()) return;
    const revision = ++generation;
    try {
      const saved = await request();
      if (revision !== generation || busy || dirty() || current && saved.version < current.version) return;
      render(saved); message('Saved');
    } catch (error) { if (revision === generation) message(error.message, true); }
  }
  form.addEventListener('input', () => { generation++; if (current && !busy) message(dirty() ? 'Unsaved changes' : 'Saved'); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!current || busy || !form.reportValidity()) return;
    const desired = fields();
    busy = true; generation++; lock();
    const endActivity = window.CeasefireActivity?.begin();
    try {
      if (conflicted) {
        const accepted = await window.CeasefireDialogs.confirm('Personal details changed',
          'Personal details were changed in another window. Save the entered details in Settings?',
          'Use entered details', 'Keep editing');
        if (!accepted) return;
        // Only the version is refreshed. The user's captured entries remain the
        // proposed edit, and a second concurrent update still conflicts safely.
        current = await request();
      }
      message('Saving…');
      const saved = await request({method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fields:desired, expected_version:current.version, ...copiedSignature})});
      current = saved; conflicted = false; copiedSignature = null;
      if (stamp(fields()) === stamp(desired)) render(saved);
      message(dirty() ? 'Unsaved changes' : 'Personal details saved. They are copied to a certificate only when it is signed.');
      if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('ceasefire:signer-defaults-saved', {detail:saved}));
    } catch (error) {
      if (error.status === 409) conflicted = true;
      message(error.status === 409 ? 'Personal details changed in another window. Your entries are kept; save again to review and retry.' : error.message, true);
    } finally { busy = false; lock(); endActivity?.(); }
  });
  const settings = document.getElementById('view-settings');
  if (settings && window.MutationObserver) new MutationObserver(() => { if (!settings.hidden) void refresh(); })
    .observe(settings, {attributes:true, attributeFilter:['hidden']});
  window.addEventListener('focus', () => { if (!settings?.hidden) void refresh(); });
  window.addEventListener('ceasefire:signer-defaults-saved', event => {
    if (busy || dirty()) return;
    try {
      const saved = valid(event.detail);
      if (current && saved.version < current.version) return;
      generation++; render(saved); message('Saved');
    } catch { /* Ignore incomplete external notifications; refresh verifies the API. */ }
  });
  window.addEventListener('beforeunload', event => {
    if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.CeasefirePersonalDetails = Object.freeze({
    hasUnsavedChanges:dirty, hasPendingOperation:() => busy || !!loading,
    fingerprint:() => stamp({fields:fields(), version:current?.version, copiedSignature, conflicted, busy}), refresh
  });
  lock(); loading = refresh().finally(() => { loading = null; });
})();
