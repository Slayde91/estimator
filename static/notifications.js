(() => {
  "use strict";
  const records = new Map();
  let navigationKey = null;
  const candidate = element => element?.matches?.('.message') && element.id !== 'project-folder' && !element.closest?.('noscript');
  function decorate(element) {
    if (!element || element.hidden || !element.textContent?.trim()) return;
    let record = records.get(element);
    if (!record) { record = { version: 0, persistent: false, button: null }; records.set(element, record); }
    if (element.getAttribute('data-notification') !== 'true') element.setAttribute('data-notification', 'true');
    if (record.button?.parentNode === element) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'notification-dismiss';
    const glyph = document.createElement('span'); glyph.className = 'notification-dismiss-glyph'; glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
    if (window.CeasefireI18n) window.CeasefireI18n.attr(button, 'aria-label', 'Close');
    else button.setAttribute('aria-label', 'Close');
    button.addEventListener('click', () => { element.hidden = true; });
    if (window.CeasefireI18n?.accessory) window.CeasefireI18n.accessory(element, button);
    else element.append(button);
    record.button = button;
  }
  function show(element, { persistent = false } = {}) {
    if (!element) return;
    let record = records.get(element);
    if (!record) { record = { version: 0, persistent: false, button: null }; records.set(element, record); }
    record.version++; record.persistent = persistent;
    element.hidden = !element.textContent?.trim();
    decorate(element);
  }
  function clear(captured = [...records].map(([element, record]) => [element, record.version])) {
    for (const [element, version] of captured) {
      const record = records.get(element);
      // A fresh condition raised during navigation owns its new notification.
      if (record && record.version === version && !record.persistent) element.hidden = true;
    }
  }
  function navigate(key) {
    if (navigationKey !== null && key !== navigationKey) clear();
    navigationKey = key;
  }
  function scan() {
    for (const element of document.querySelectorAll('.message')) if (candidate(element)) decorate(element);
    for (const [element] of records) {
      if (element.isConnected === false) records.delete(element);
      // Helper/status notices can replace their text without using .message.
      // Restore their control after refreshes while respecting a prior dismissal.
      else decorate(element);
    }
  }
  window.CeasefireNotifications = { show, navigate, clear };
  // Only selection tabs participate. Action buttons and download progress keep
  // their normal lifecycle, including long preparation and retry operations.
  document.addEventListener('click', event => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || tab.getAttribute('aria-selected') === 'true') return;
    const captured = [...records].map(([element, record]) => [element, record.version]);
    queueMicrotask(() => { if (tab.getAttribute('aria-selected') === 'true') clear(captured); });
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  if (window.MutationObserver && document.body) {
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  scan();
})();
