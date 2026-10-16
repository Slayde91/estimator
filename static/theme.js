/* Appearance is a browser preference; it never enters a project or calculator. */
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

  const root = document.documentElement;
  const button = document.getElementById('theme-toggle');
  if (!root || !button || button.dataset.themeReady === 'true') return;
  const themes = [
    { id: 'ceasefire', name: 'CLASSIFIRE' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'ocean', name: 'Ocean' },
    { id: 'forest', name: 'Forest' },
    { id: 'slate', name: 'Slate' },
  ];
  const key = 'ceasefire.ui.theme.v1';
  const status = document.getElementById('theme-status');
  let current = 0;
  try {
    const stored = window.localStorage.getItem(key);
    const index = themes.findIndex(theme => theme.id === stored);
    if (index >= 0) current = index;
  } catch (_) { /* A blocked preference store still permits session appearance. */ }
  function apply(announce) {
    const theme = themes[current], next = themes[(current + 1) % themes.length];
    root.setAttribute('data-theme', theme.id);
    uiAttr(button, 'aria-label', "Theme: {0}. Next theme: {1}.", [() => window.CeasefireI18n?.translate(theme.name) || theme.name, () => window.CeasefireI18n?.translate(next.name) || next.name]);
    uiAttr(button, 'title', "Theme: {0}. Next theme: {1}.", [() => window.CeasefireI18n?.translate(theme.name) || theme.name, () => window.CeasefireI18n?.translate(next.name) || next.name]);
    if (announce && status) uiText(status, "{0} theme selected.", [() => window.CeasefireI18n?.translate(theme.name) || theme.name]);
  }
  apply(false);
  button.dataset.themeReady = 'true';
  button.addEventListener('click', () => {
    current = (current + 1) % themes.length;
    apply(true);
    try { window.localStorage.setItem(key, themes[current].id); } catch (_) {}
  });
})();
