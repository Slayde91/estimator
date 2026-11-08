(() => {
  "use strict";
  const records = new Map();
  const downloads = new Map();
  let navigationKey = null;
  const candidate = element => element?.matches?.('.message') && element.id !== 'project-folder' && !element.closest?.('noscript');
  function rememberDownload(receipt) {
    if (!receipt || typeof receipt.filename !== 'string' || !/\.(pdf|xlsx)$/i.test(receipt.filename) ||
        !/^\/api\/download-files\/[A-Za-z0-9_-]{32}$/.test(receipt.download_url || '') ||
        (/\.xlsx$/i.test(receipt.filename) && receipt.open_url !== receipt.download_url + '/open') ||
        (/\.pdf$/i.test(receipt.filename) && receipt.open_url)) return;
    downloads.delete(receipt.download_url);
    downloads.set(receipt.download_url, {...receipt});
    while (downloads.size > 256) downloads.delete(downloads.keys().next().value);
  }
  function linkDownloads(element, record, fresh = false) {
    if (!document.createTreeWalker) return;
    const source = window.CeasefireI18n?.source(element) || element.textContent;
    if (fresh || record.downloadSource !== source) {
      record.downloadSource = source;
      const available = [...downloads.values()].reverse(), exact = available.filter(item => item.path && source.includes(item.path));
      record.downloads = available.filter(item => source.includes(item.path) || source.includes(item.filename))
        .filter(item => !exact.some(other => other.filename === item.filename) || exact.includes(item));
    }
    const render = () => {
      const choices = record.downloads || [];
      const choose = value => {
        // Prefer the exact saved path over an identically named file in a
        // different Project. A filename-only notice binds its newest receipt.
        let first = null;
        for (const field of ['path', 'filename']) for (const item of choices) {
          const label = item[field], offset = label ? value.indexOf(label) : -1;
          if (offset >= 0 && (!first || offset < first.offset || offset === first.offset && label.length > first.label.length)) first = {item,label,offset};
        }
        return first;
      };
      for (const link of element.querySelectorAll('a.notification-file-link')) {
        const match = choose(link.textContent);
        if (match && link.getAttribute('href') !== match.item.download_url) link.replaceWith(document.createTextNode(link.textContent));
      }
      const walker = document.createTreeWalker(element, 4), nodes = [];
      while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('a,button')) nodes.push(walker.currentNode);
      function fileLink(chosen, label) {
        const link = document.createElement('a'); link.className = 'notification-file-link';
        link.href = chosen.download_url; link.textContent = label;
        if (/\.pdf$/i.test(chosen.filename)) { link.target = '_blank'; link.rel = 'noopener'; }
        else {
          link.addEventListener('click', async event => {
            event.preventDefault();
            if (link.getAttribute('aria-busy') === 'true') return;
            link.setAttribute('aria-busy', 'true');
            try {
              const response = await fetch(chosen.open_url, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
              const result = await response.json();
              if (!response.ok || result.opened !== true) throw new Error(result.error || 'The workbook could not be opened. Check its default application.');
            } catch (error) {
              const notice = document.createElement('p'); notice.className = 'message error'; notice.setAttribute('role', 'alert');
              if (window.CeasefireI18n) window.CeasefireI18n.text(notice, '{0}', [() => window.CeasefireI18n.translate(error.message)]);
              else notice.textContent = error.message;
              element.after(notice); show(notice);
            } finally { link.removeAttribute('aria-busy'); }
          });
        }
        return link;
      }
      for (const text of nodes) {
        let remaining = text.textContent, match = choose(remaining);
        if (!match) continue;
        const parts = [];
        do {
          parts.push(document.createTextNode(remaining.slice(0, match.offset)), fileLink(match.item, match.label));
          remaining = remaining.slice(match.offset + match.label.length);
          match = choose(remaining);
        } while (match);
        parts.push(document.createTextNode(remaining)); text.replaceWith(...parts);
      }
    };
    if (window.CeasefireI18n?.decorateText) window.CeasefireI18n.decorateText(element, render);
    else render();
  }
  function revealError(element, record, force = false) {
    const error = /(?:^|\s)error(?:\s|$)/.test(element.className) || element.getAttribute('role') === 'alert';
    if (!error || element.hidden) { record.errorText = null; return; }
    const source = window.CeasefireI18n?.source(element) || element.textContent;
    if (!source?.trim() || !element.getBoundingClientRect || !element.getClientRects().length) return;
    if (!force && record.errorText === source) return;
    record.errorText = source;
    const version = record.version;
    const reveal = () => {
      if (element.hidden || record.version !== version || record.errorText !== source || !element.getClientRects().length) return;
      const top = Math.max(0, document.querySelector?.('.app-header')?.getBoundingClientRect().bottom || 0) + 12;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < top || bounds.bottom > window.innerHeight)
        window.scrollBy?.({ top: bounds.top - top, behavior: 'instant' });
    };
    reveal();
    // Field validation can run before Tab's native focus scroll. Reveal once
    // more after that action, without stealing keyboard focus or polling.
    window.requestAnimationFrame?.(() => window.requestAnimationFrame(reveal));
  }
  function decorate(element) {
    if (!element || element.hidden || !element.textContent?.trim()) return;
    let record = records.get(element);
    if (!record) { record = { version: 0, persistent: false, button: null }; records.set(element, record); }
    linkDownloads(element, record);
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
    linkDownloads(element, record, true);
    element.hidden = !element.textContent?.trim();
    decorate(element);
    revealError(element, record, true);
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
      else { decorate(element); revealError(element, records.get(element)); }
    }
  }
  window.CeasefireNotifications = { show, navigate, clear, rememberDownload };
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
