(() => {
  'use strict';
  // Bind application-owned copy only; node() remains safe for user and source text.
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index])); return element;
  };
  const uiAttr = (element, name, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.attr(element, name, source, args);
    const value = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
    element.setAttribute(name, value); if (["title", "placeholder"].includes(name)) element[name] = value; return element;
  };

  const form = document.getElementById('company-settings-form');
  if (!form) return;
  const status = document.getElementById('company-settings-status');
  const preview = document.getElementById('company-logo-preview');
  const file = document.getElementById('company-logo');
  const coverFile = document.getElementById('company-cover-pdf');
  const coverName = document.getElementById('company-cover-name');
  const coverDelete = document.getElementById('company-cover-delete');
  const save = document.getElementById('company-settings-save');
  let current = null, logo = null, removed = false, coverPdf = null, coverPdfName = '', reading = false, saving = false;
  const fields = ['name', 'abn', 'phone', 'email'];
  const message = (text, error = false) => { uiText(status, text); status.className = error ? 'message error' : 'status-label calculator-status'; };
  const renderLogo = () => {
    preview.hidden = removed;
    if (removed) preview.removeAttribute('src');
    else preview.src = logo || '/classifire-logo.png';
  };
  const dirty = () => { if (current) message('Unsaved changes'); };
  const renderCover = () => {
    if (coverName) uiText(coverName, coverPdf ? 'Cover sheet: {0}' : 'No cover sheet selected.', coverPdf ? [coverPdfName || 'Cover sheet.pdf'] : []);
    if (coverDelete) coverDelete.disabled = !current || !coverPdf || saving || reading;
  };
  const disableUploads = disabled => { file.disabled = disabled; if (coverFile) coverFile.disabled = disabled; };
  form.addEventListener('input', dirty);
  file.addEventListener('change', async () => {
    const chosen = file.files[0];
    if (!chosen || saving || reading) return;
    if (!['image/png', 'image/jpeg'].includes(chosen.type) || chosen.size > 2 * 1024 * 1024) { message('Choose a PNG or JPEG logo smaller than 2 MB.', true); file.value = ''; return; }
    reading = true; disableUploads(true); save.disabled = true; renderCover();
    const endActivity = window.CeasefireActivity?.begin();
    try {
      const next = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('The logo could not be read.')); reader.readAsDataURL(chosen); });
      logo = next; removed = false; renderLogo(); dirty();
    } catch (error) { message(error.message, true); }
    finally { reading = false; disableUploads(false); save.disabled = !current; renderCover(); endActivity?.(); }
  });
  coverFile?.addEventListener('change', async () => {
    const chosen = coverFile.files[0];
    if (!chosen || saving || reading) return;
    if ((!/\.pdf$/i.test(chosen.name) && chosen.type !== 'application/pdf') || chosen.size > 10 * 1024 * 1024 || !chosen.size) {
      message('Choose a PDF cover sheet smaller than 10 MB.', true); coverFile.value = ''; return;
    }
    reading = true; disableUploads(true); save.disabled = true; renderCover();
    const endActivity = window.CeasefireActivity?.begin();
    try {
      const next = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('The PDF cover sheet could not be read.')); reader.readAsDataURL(chosen); });
      coverPdf = 'data:application/pdf;base64,' + String(next).split(',')[1];
      coverPdfName = chosen.name; renderCover(); dirty();
    } catch (error) { message(error.message, true); }
    finally { reading = false; disableUploads(false); save.disabled = !current; renderCover(); endActivity?.(); }
  });
  coverDelete?.addEventListener('click', () => { if (saving || reading) return; coverPdf = null; coverPdfName = ''; coverFile.value = ''; renderCover(); dirty(); });
  document.getElementById('company-logo-delete').addEventListener('click', () => { if (saving || reading) return; logo = null; removed = true; file.value = ''; renderLogo(); dirty(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!current || reading || saving) return;
    const captured = Object.fromEntries(fields.map(key => [key, document.getElementById(`company-${key}`).value])); captured.logo = logo; captured.cover_pdf = coverPdf; captured.cover_pdf_name = coverPdfName;
    saving = true; message('Saving…'); for (const control of form.elements) control.disabled = true;
    const endActivity = window.CeasefireActivity?.begin();
    try {
      const response = await fetch('/api/company-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(captured) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Company settings could not be saved.');
      current = result; logo = result.logo; removed = false; coverPdf = result.cover_pdf || null; coverPdfName = result.cover_pdf_name || ''; for (const key of fields) document.getElementById(`company-${key}`).value = result[key]; renderLogo(); renderCover(); message('Saved');
      if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.CustomEvent('ceasefire:company-settings-saved', { detail: { name: result.name } }));
    } catch (error) { message(error.message, true); }
    finally { saving = false; for (const control of form.elements) control.disabled = false; renderCover(); endActivity?.(); }
  });
  async function load() {
    for (const control of form.elements) control.disabled = true;
    const endActivity = window.CeasefireActivity?.begin();
    try {
      const response = await fetch('/api/company-settings'); const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Company settings could not be loaded.');
      current = result; logo = result.logo; coverPdf = result.cover_pdf || null; coverPdfName = result.cover_pdf_name || ''; for (const key of fields) document.getElementById(`company-${key}`).value = result[key]; renderLogo(); message('Saved'); for (const control of form.elements) control.disabled = false; renderCover();
    } catch (error) { message(error.message, true); }
    finally { endActivity?.(); }
  }
  void load();
})();
