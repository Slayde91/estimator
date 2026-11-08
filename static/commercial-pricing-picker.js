(() => {
  'use strict';
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = source.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  };
  const uiAttr = (element, name, source) => window.CeasefireI18n
    ? window.CeasefireI18n.attr(element, name, source) : element.setAttribute(name, source);
  const price = new Intl.NumberFormat('en-AU', {style:'currency', currency:'AUD', minimumFractionDigits:2, maximumFractionDigits:6});
  const attributes = ['role', 'aria-controls', 'aria-autocomplete', 'aria-expanded', 'aria-activedescendant', 'autocomplete', 'placeholder'];

  function attach(input, {onSelect, searchItems, isCurrent = () => true} = {}) {
    if (!input || typeof onSelect !== 'function') return () => {};
    const original = new Map(attributes.map(name => [name, input.getAttribute(name)]));
    const popup = document.createElement('div'), list = document.createElement('div'), status = document.createElement('p');
    popup.className = 'commercial-pricing-popup'; popup.hidden = true;
    list.id = 'commercial-pricing-' + crypto.randomUUID(); list.setAttribute('role', 'listbox');
    uiAttr(list, 'aria-label', 'Pricing Library matches');
    status.className = 'helper'; status.setAttribute('role', 'status');
    popup.append(list, status); document.body.append(popup);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false'); input.setAttribute('autocomplete', 'off');
    if (!input.getAttribute('placeholder')) uiAttr(input, 'placeholder', 'Search Pricing Library or enter manually');
    let disposed = false, ticket = 0, timer = null, controller = null, matches = [], active = -1, renderedQuery = '';
    const listeners = [];
    function listen(target, event, callback) { target.addEventListener(event, callback); listeners.push([target, event, callback]); }
    const current = () => !disposed && input.isConnected && !input.disabled && !input.readOnly && isCurrent();
    function cancel() { clearTimeout(timer); timer = null; controller?.abort(); controller = null; ticket++; }
    function close() {
      cancel(); popup.hidden = true; matches = []; active = -1;
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', reposition);
    }
    function reposition() {
      const bounds = input.getBoundingClientRect(), headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
      if (current() && document.activeElement === input && bounds.bottom > headerBottom && bounds.top < window.innerHeight) show();
      else close();
    }
    function scrolled(event) { if (!popup.contains(event.target)) reposition(); }
    function show() {
      if (!current() || document.activeElement !== input) return;
      const bounds = input.getBoundingClientRect(), viewportWidth = document.documentElement.clientWidth, viewportHeight = window.innerHeight;
      const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
      const topEdge = Math.max(8, headerBottom + 8);
      const width = Math.min(Math.max(bounds.width, 260), Math.max(120, viewportWidth - 24));
      const rtl = getComputedStyle(input).direction === 'rtl';
      popup.style.width = width + 'px'; popup.style.left = Math.max(12, Math.min(rtl ? bounds.right - width : bounds.left, viewportWidth - width - 12)) + 'px';
      popup.style.maxHeight = Math.max(80, Math.min(300, viewportHeight - 24)) + 'px';
      popup.hidden = false;
      const needed = popup.getBoundingClientRect().height, below = viewportHeight - Math.max(bounds.bottom, topEdge) - 12, above = bounds.top - topEdge - 4;
      const upwards = below < needed && above > below;
      popup.style.maxHeight = Math.max(40, Math.min(300, upwards ? above : below)) + 'px';
      popup.style.top = (upwards ? Math.max(topEdge, bounds.top - popup.getBoundingClientRect().height - 4) : Math.max(topEdge, bounds.bottom + 4)) + 'px';
      input.setAttribute('aria-expanded', 'true');
      window.addEventListener('scroll', scrolled, true); window.addEventListener('resize', reposition);
    }
    function highlight(index) {
      active = index;
      [...list.children].forEach((option, row) => option.setAttribute('aria-selected', String(row === index)));
      if (index >= 0) { input.setAttribute('aria-activedescendant', list.children[index].id); list.children[index].scrollIntoView({block:'nearest'}); }
    }
    function choose(index) {
      const item = matches[index];
      if (!item || !current() || input.value !== renderedQuery || document.activeElement !== input) return;
      close(); onSelect({...item});
    }
    function render(items, query) {
      matches = items; active = -1; renderedQuery = query; input.removeAttribute('aria-activedescendant');
      list.replaceChildren(...items.map((item, index) => {
        const option = document.createElement('button'), name = document.createElement('span'), amount = document.createElement('small');
        option.type = 'button'; option.tabIndex = -1; option.id = list.id + '-' + index; option.className = 'commercial-pricing-option';
        option.dataset.pricingId = item.id; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
        option.setAttribute('aria-posinset', String(index + 1)); option.setAttribute('aria-setsize', String(items.length));
        name.textContent = item.name; amount.textContent = price.format(item.unit_price) + (item.unit ? ' / ' + item.unit : '');
        option.append(name, amount); option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => choose(index));
        return option;
      }));
      if (!items.length) uiText(status, 'No matching products or services. You can enter a description and price manually.');
      else if (items.length === 30) uiText(status, 'Showing up to 30 matches. Type more to narrow the list.');
      else uiText(status, '{0} choices', [items.length]);
      show();
    }
    async function search(query, captured) {
      if (!current() || document.activeElement !== input || ticket !== captured || input.value !== query) return;
      const request = new AbortController(); controller = request;
      try {
        const response = searchItems ? null : await fetch('/api/commercial/pricing?search=' + encodeURIComponent(query), {cache:'no-store', signal:request.signal});
        const data = searchItems ? {items:await searchItems(query)} : await response.json();
        if (!current() || document.activeElement !== input || ticket !== captured || input.value !== query) return;
        if (response && !response.ok || !Array.isArray(data.items)) throw Error('Pricing request failed');
        const items = data.items.slice(0,30).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string'
          && typeof item.description === 'string' && typeof item.unit_price === 'number' && Number.isFinite(item.unit_price) && Math.abs(item.unit_price) <= 1000000000);
        render(items, query);
      } catch (error) {
        if (error.name === 'AbortError' || !current() || document.activeElement !== input || ticket !== captured || input.value !== query) return;
        matches = []; list.replaceChildren(); uiText(status, 'Pricing Library could not be loaded. You can enter a description and price manually.'); show();
      } finally { if (controller === request) controller = null; }
    }
    function schedule(immediate = false) {
      close();
      if (!current() || document.activeElement !== input) return;
      const query = input.value, captured = ticket;
      if(!query.trim())return;
      list.replaceChildren();
      if (query.length > 500) { uiText(status, 'Type up to 500 characters to search Pricing Library.'); show(); return; }
      uiText(status, 'Searching Pricing Library…'); show();
      timer = setTimeout(() => { timer = null; void search(query, captured); }, immediate ? 0 : 180);
    }
    listen(input, 'focus', () => schedule(true));
    listen(input, 'input', event => { if (!event.isComposing) schedule(); });
    listen(input, 'compositionend', () => schedule());
    listen(input, 'blur', close);
    listen(input, 'keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation(); schedule(true);
      } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
                 && ['ArrowDown', 'ArrowUp'].includes(event.key) && !popup.hidden && matches.length) {
        event.preventDefault(); event.stopPropagation();
        highlight(Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
      } else if (event.key === 'Enter' && !popup.hidden && active >= 0) { event.preventDefault(); event.stopPropagation(); choose(active); }
    });
    return () => {
      if (disposed) return;
      close(); disposed = true; listeners.forEach(([target, event, callback]) => target.removeEventListener(event, callback));
      popup.remove();
      for (const [name, value] of original) { if (value === null) input.removeAttribute(name); else input.setAttribute(name, value); }
    };
  }
  window.ClassifireCommercialPricing = Object.freeze({attach});
})();
