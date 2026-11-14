(() => {
  "use strict";
  const records = new Map();
  const presentations = new WeakMap();
  const downloads = new Map();
  let navigationKey = null;
  const noticeSelector = '.message, [data-notification="true"]';
  const candidate = element => element.id !== 'project-folder' && !element.hasAttribute('data-notification-passive') && !element.closest?.('noscript');
  let bleep;
  try {
    bleep = new window.Audio();
    bleep.preload = 'auto';
    bleep.src = '/sounds/radiobleep.mp3';
    bleep.load();
  } catch { /* Notifications still work without audio support. */ }
  function stopBleep() {
    try { bleep?.pause(); if (bleep) bleep.currentTime = 0; } catch { /* Media may be unavailable. */ }
  }
  window.CeasefireAudioSettings?.subscribe(enabled => { if (!enabled) stopBleep(); });
  window.addEventListener?.('pagehide', stopBleep);
  function isError(element) {
    return /(?:^|\s)error(?:\s|$)/.test(element.className) || element.getAttribute('role') === 'alert';
  }
  function presentation(element, eligible, explicit = false) {
    const source = window.CeasefireI18n?.source(element) || element.textContent;
    if (!eligible || element.hidden || !source?.trim()) {
      presentations.delete(element);
      return null;
    }
    const error = isError(element);
    const previous = presentations.get(element);
    const rendered = Boolean(element.isConnected && element.getClientRects?.().length);
    if (previous && previous.source === source && previous.error === error) {
      // Revealing a workspace must not announce content prepared while it was hidden.
      // Its owner can still deliberately present that message once the view is open.
      if (!explicit || previous.rendered || !rendered) return null;
    }
    const current = { source, error, rendered, sounded: false };
    presentations.set(element, current);
    return current;
  }
  function visibleAtDestination(element, bounds) {
    if (element.closest?.('[aria-hidden="true"], [inert], .sr-only')) return false;
    if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
    const left = Math.max(0, bounds.left), right = Math.min(window.innerWidth, bounds.right);
    if (bottom <= top || right <= left) return false;
    // Hit testing also excludes notices clipped inside a panel or behind a modal.
    const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return element.contains(target);
  }
  function soundVisible(element, current) {
    if (!current || current.sounded || presentations.get(element) !== current ||
        !bleep || bleep.readyState < 3 || document.hidden ||
        window.CeasefireAudioSettings?.isEnabled() === false || element.hidden ||
        !element.isConnected || !element.getClientRects?.().length) return;
    if (!visibleAtDestination(element, element.getBoundingClientRect())) return;
    current.sounded = true;
    try {
      bleep.currentTime = 0;
      bleep.play()?.catch(() => {});
    } catch { /* A blocked sound must never delay or hide the notice. */ }
  }
  function presentInline(element, { block, announce = true } = {}) {
    if (!element) return;
    const current = presentation(element, announce, true);
    if (!current?.rendered) return;
    if (element.matches('.message')) decorate(element);
    if (block && current.error) element.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' });
    soundVisible(element, current);
  }
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
  function present(element, explicit = false) {
    const current = presentation(element, isError(element) || element.matches('.message'), explicit);
    if (!current?.rendered) return;
    if (!current.error) { soundVisible(element, current); return; }
    const reveal = () => {
      if (element.hidden || presentations.get(element) !== current || !element.getClientRects().length) return;
      const top = Math.max(0, document.querySelector?.('.app-header')?.getBoundingClientRect().bottom || 0) + 12;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < top || bounds.bottom > window.innerHeight)
        window.scrollBy({ top: bounds.top - top, behavior: 'instant' });
      soundVisible(element, current);
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
    button.addEventListener('click', () => { element.hidden = true; presentations.delete(element); });
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
    present(element, true);
  }
  function clear(captured = [...records].map(([element, record]) => [element, record.version])) {
    for (const [element, version] of captured) {
      const record = records.get(element);
      // A fresh condition raised during navigation owns its new notification.
      if (record && record.version === version && !record.persistent) { element.hidden = true; presentations.delete(element); }
    }
  }
  function navigate(key) {
    if (navigationKey !== null && key !== navigationKey) clear();
    navigationKey = key;
  }
  function refreshNotice(element) {
    if (!candidate(element) || element.isConnected === false) return;
    if (records.has(element) || element.matches('.message')) {
      decorate(element);
      present(element);
    }
  }
  function scan(mutations) {
    if (!mutations) {
      for (const element of document.querySelectorAll(noticeSelector)) refreshNotice(element);
      return;
    }
    const changed = new Set();
    function collect(node) {
      if (node.matches?.(noticeSelector)) changed.add(node);
      for (const match of node.querySelectorAll?.(noticeSelector) || []) changed.add(match);
    }
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
      const notice = target?.closest?.(noticeSelector);
      if (notice) changed.add(notice);
      if (mutation.type === 'attributes' && mutation.attributeName === 'hidden' && !target.hidden) collect(target);
      for (const node of mutation.addedNodes) collect(node);
    }
    for (const element of records.keys()) if (element.isConnected === false) records.delete(element);
    for (const element of changed) refreshNotice(element);
  }
  window.CeasefireNotifications = { show, presentInline, navigate, clear, rememberDownload };
  // Only selection tabs participate. Action buttons and download progress keep
  // their normal lifecycle, including long preparation and retry operations.
  document.addEventListener('click', event => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || tab.getAttribute('aria-selected') === 'true') return;
    const captured = [...records].map(([element, record]) => [element, record.version]);
    queueMicrotask(() => { if (tab.getAttribute('aria-selected') === 'true') clear(captured); });
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopBleep(); clear(); } });
  if (window.MutationObserver && document.body) {
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'role'] });
  }
  scan();
})();
