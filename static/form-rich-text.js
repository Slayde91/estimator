(() => {
  'use strict';
  const tags = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li']);
  const translate = label => window.CeasefireI18n?.translate(label) || label;

  // Legacy strings are literal text. Only explicitly tagged values contain formatting.
  function content(value) {
    const view = document.createElement('div');
    view.className = 'form-rich-content';
    if (typeof value?.html !== 'string') {
      view.textContent = typeof value === 'string' ? value : '';
      return view;
    }
    const template = document.createElement('template');
    template.innerHTML = value.html;
    copyContent(template.content, view);
    return view;
  }
  function copyContent(source, target, depth = 0) {
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { target.append(child.data); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || ['script','style','template'].includes(child.localName)) continue;
      if (depth >= 32) { target.append(child.textContent); continue; }
      const element = tags.has(child.localName) ? document.createElement(child.localName) : null;
      if (element) target.append(element);
      copyContent(child, element || target, depth + 1);
    }
  }
  function editor(label, value, change) {
    const wrapper = document.createElement('div');
    const toolbar = document.createElement('div');
    toolbar.className = 'form-rich-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', translate('Text formatting'));
    const area = content(value);
    area.contentEditable = 'true';
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    area.setAttribute('aria-label', label);
    function storeValue() {
      const safe = document.createElement('div');
      copyContent(area, safe);
      change(!safe.textContent.trim() ? '' : safe.childElementCount ? {html:safe.innerHTML} : safe.textContent);
    }
    for (const [name, command, icon] of [
      ['Bold','bold','B'], ['Italic','italic','I'], ['Underline','underline','U'],
      ['Bullets','insertUnorderedList','• ≡'], ['Numbered list','insertOrderedList','1. ≡']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.title = translate(name);
      button.setAttribute('aria-label', button.title);
      button.textContent = icon;
      button.dataset.command = command;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        area.focus();
        document.execCommand('styleWithCSS', false, false);
        document.execCommand(command, false);
      });
      toolbar.append(button);
    }
    area.addEventListener('input', storeValue);
    area.addEventListener('blur', () => area.dispatchEvent(new Event('change', {bubbles:true})));
    area.addEventListener('paste', event => {
      event.preventDefault();
      const html = event.clipboardData.getData('text/html');
      if (html) document.execCommand('insertHTML', false, content({html}).innerHTML);
      else document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    area.addEventListener('drop', event => event.preventDefault());
    wrapper.className = 'form-rich-editor';
    wrapper.append(toolbar, area);
    return wrapper;
  }
  window.ClassifireFormRichText = {content, editor};
})();
