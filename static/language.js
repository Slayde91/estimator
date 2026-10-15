/* Local UI language only. Never changes project data, calculation values or source evidence. */
(() => {
  'use strict';
  const root = document.documentElement;
  const key = 'ceasefire.ui.language.v1';
  const languages = Object.freeze(['en', 'zh-Hans', 'hi', 'es', 'ar', 'th']);
  const messages = window.CeasefireMessages || {};
  const bindings = new Map();
  const termToken = Symbol('owned UI term');
  let language = 'en';
  try { const saved = localStorage.getItem(key); if (languages.includes(saved)) language = saved; } catch (_) {}
  const format = (source, args = [], localized = false) => String(source).replace(/\{(\d+)\}/g, (match, index) => {
    if (index >= args.length) return match;
    const value = typeof args[index] === 'function' ? args[index]() : args[index];
    if (value?.[termToken]) return localized ? translate(value.source, value.args) : format(value.source, value.args);
    return String(value ?? '');
  });
  function translate(source, args = []) {
    const index = languages.indexOf(language) - 1;
    const translation = index >= 0 && Object.prototype.hasOwnProperty.call(messages, source) ? messages[source][index] : null;
    return format(typeof translation === 'string' && translation ? translation : source, args, true);
  }
  const read = (element, attribute) => attribute ? element.getAttribute(attribute) : element.textContent;
  function current(binding) {
    if (read(binding.element, binding.attribute) !== binding.last) return false;
    if (binding.attribute || binding.element.nodeType !== 1) return true;
    const children = binding.element.childNodes;
    return children.length === binding.children.length && binding.children.every((node, index) => children[index] === node);
  }
  function write(binding) {
    const {element, attribute, source, args} = binding;
    const value = translate(source, args);
    if (!attribute && binding.original && language === 'en') element.replaceChildren(...binding.original.map(node => node.cloneNode(true)));
    else if (attribute) element.setAttribute(attribute, value);
    else if (element.textContent !== value) element.textContent = value;
    binding.last = read(element, attribute);
    binding.children = [...element.childNodes];
  }
  function bind(element, attribute, source, args = [], original = null) {
    if (!element) return element;
    // An option without an explicit value derives its value from its label. Freeze the
    // English value before presenting a translation, including for newly created options.
    if (!attribute && element.tagName === 'OPTION' && !element.hasAttribute('value')) element.value = format(source, args);
    let slots = bindings.get(element);
    if (!slots) { slots = new Map(); bindings.set(element, slots); }
    const binding = {element, attribute, source: String(source), args: [...args], original, last: read(element, attribute)};
    slots.set(attribute || '', binding);
    write(binding);
    return element;
  }
  function source(element, attribute = null) {
    if (!element) return '';
    const binding = bindings.get(element)?.get(attribute || '');
    if (binding && current(binding)) return format(binding.source, binding.args);
    if (!attribute && element.childNodes?.length) return [...element.childNodes].map(child => source(child)).join('');
    return read(element, attribute);
  }
  function refresh() {
    for (const [element, slots] of bindings) {
      if (!element.isConnected) { bindings.delete(element); continue; }
      for (const [name, binding] of slots) {
        // A subsequent unbound user/source update takes ownership of the node. Never
        // overwrite that content with a stale UI label on the next language change.
        if (!current(binding)) slots.delete(name);
        else write(binding);
      }
      if (!slots.size) bindings.delete(element);
    }
  }
  function annotate(scope) {
    const selector = '[data-i18n],[data-i18n-rich],[data-i18n-leading],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder],[data-i18n-alt]';
    const elements = [...(scope.matches?.(selector) ? [scope] : []), ...scope.querySelectorAll?.(selector) || []];
    for (const element of elements) {
      if (element.hasAttribute('data-i18n-leading')) {
        const text = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
        if (text) bind(text, null, element.getAttribute('data-i18n-leading'));
        element.removeAttribute('data-i18n-leading');
      }
      if (element.hasAttribute('data-i18n')) {
        bind(element, null, element.getAttribute('data-i18n')); element.removeAttribute('data-i18n');
      } else if (element.hasAttribute('data-i18n-rich')) {
        bind(element, null, element.getAttribute('data-i18n-rich'), [], [...element.childNodes].map(node => node.cloneNode(true)));
        element.removeAttribute('data-i18n-rich');
      }
      for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
        const marker = 'data-i18n-' + attribute;
        if (element.hasAttribute(marker)) { bind(element, attribute, element.getAttribute(marker)); element.removeAttribute(marker); }
      }
    }
  }
  function setLanguage(next, persist = true) {
    if (!languages.includes(next)) return false;
    language = next;
    root.lang = language === 'en' ? 'en-AU' : language;
    root.dir = language === 'ar' ? 'rtl' : 'ltr';
    root.dataset.language = language;
    refresh();
    const select = document.getElementById('application-language');
    if (select) select.value = language;
    if (persist) { try { localStorage.setItem(key, language); } catch (_) {} }
    window.dispatchEvent(new CustomEvent('ceasefire:languagechange', {detail: {language}}));
    return true;
  }
  window.CeasefireI18n = Object.freeze({
    text: (element, text, args) => bind(element, null, text, args),
    nodeText: (element, text, args = []) => {
      if (element.tagName === 'OPTION' && !element.hasAttribute('value')) element.value = format(text, args);
      const node = document.createTextNode(''); element.append(node);
      bind(node, null, text, args); return element;
    },
    attr: (element, attribute, text, args) => bind(element, attribute, text, args),
    source, translate, setLanguage, languages,
    term: (source, args = []) => Object.freeze({[termToken]: true, source, args}),
    get language() { return language; },
  });
  annotate(document);
  setLanguage(language, false);
  document.getElementById('application-language')?.addEventListener('change', event => {
    setLanguage(event.target.value);
    const status = document.getElementById('language-status');
    if (status) bind(status, null, 'Application language updated.');
  });
  window.addEventListener('storage', event => {
    if (event.key === key) setLanguage(languages.includes(event.newValue) ? event.newValue : 'en', false);
  });
  // Only explicitly marked application-owned UI is processed. Drawings, user entries,
  // report text, product names and arbitrary matching English strings are never scanned.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1) annotate(node);
      // Large registers are rebuilt regularly. Release removed labels immediately
      // instead of retaining their entire detached row until a language switch.
      for (const removed of record.removedNodes || []) {
        if (removed.isConnected) continue;
        const pending = [removed];
        while (pending.length) {
          const node = pending.pop(); bindings.delete(node);
          pending.push(...node.childNodes);
        }
      }
    }
  });
  observer.observe(document.body, {childList: true, subtree: true});
})();
