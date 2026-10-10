/* Appearance is a browser preference; it never enters a project or calculator. */
(() => {
  'use strict';
  const root = document.documentElement;
  const button = document.getElementById('theme-toggle');
  if (!root || !button || button.dataset.themeReady === 'true') return;
  const themes = [
    { id: 'ceasefire', name: 'Ceasefire' },
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
    button.setAttribute('aria-label', `Theme: ${theme.name}. Next theme: ${next.name}.`);
    button.setAttribute('title', `Theme: ${theme.name}. Next theme: ${next.name}.`);
    if (announce && status) status.textContent = `${theme.name} theme selected.`;
  }
  apply(false);
  button.dataset.themeReady = 'true';
  button.addEventListener('click', () => {
    current = (current + 1) % themes.length;
    apply(true);
    try { window.localStorage.setItem(key, themes[current].id); } catch (_) {}
  });
})();
