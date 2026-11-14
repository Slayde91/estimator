(() => {
  'use strict';

  function picker(entry, onSelect) {
    const section = document.createElement('section');
    section.className = 'card register-library-picker';
    const element = (tag, label, args = []) => {
      const node = document.createElement(tag);
      if (label) window.CeasefireI18n.text(node, label, args);
      return node;
    };
    const button = (label, click) => {
      const node = element('button', label);
      node.type = 'button';
      node.className = 'button secondary';
      node.addEventListener('click', click);
      return node;
    };
    const filters = element('div'), results = element('div'), status = element('p'), pager = element('div');
    filters.className = 'library-filters';
    results.className = 'table-scroll';
    status.className = 'helper';
    status.setAttribute('aria-live', 'polite');
    pager.className = 'library-pagination';
    section.append(element('h2', 'Technical Library'), filters, status, results, pager);
    const limit = 20;
    const values = {...entry.technical_filters};
    let offset = 0, controller, definitions, selectedItem;

    function clear() {
      controller?.abort();
      results.replaceChildren();
      pager.replaceChildren();
      status.replaceChildren();
    }
    function row(item, selected) {
      const tr = element('tr'), check = element('input'), preview = element('td');
      check.type = 'checkbox';
      check.checked = selected;
      const title = window.LibraryDetailText.displayTitle(item);
      check.setAttribute('aria-label', title);
      check.dataset.technicalItemId = item.id;
      check.addEventListener('change', () => {
        selectedItem = check.checked ? item : null;
        entry.technical_item_id = check.checked ? item.id : '';
        entry.technical_filters = {};
        if (check.checked) {
          for (const key of ['substrate', 'orientation', 'manufacturer']) {
            if (values[key]) entry.technical_filters[key] = values[key];
          }
        }
        onSelect();
        load().then(() => (results.querySelector('input') || filters.querySelector('select'))?.focus({preventScroll:true}));
      });
      const choice = element('td');
      choice.append(check);
      if (/^\/api\/libraries\/images\/[a-z0-9][a-z0-9_-]{0,119}\/thumbnail$/.test(item.thumbnail_url || '')) {
        const image = element('img');
        image.loading = 'lazy';
        image.src = item.thumbnail_url;
        image.alt = window.CeasefireI18n.translate('Source diagram');
        image.addEventListener('error', () => { preview.textContent = '—'; }, {once:true});
        preview.append(image);
      } else preview.textContent = '—';
      tr.append(choice, preview);
      for (const text of [title, window.LibraryDetailText.displaySubtitle(item)]) {
        const cell = element('td'); cell.textContent = text || '—'; tr.append(cell);
      }
      return tr;
    }
    function table(items, selected = false) {
      const grid = element('table'), head = grid.createTHead().insertRow(), body = grid.createTBody();
      for (const title of ['Select', 'Diagram', 'Technical Library item', 'Details']) {
        const th = element('th', title);
        th.scope = 'col';
        head.append(th);
      }
      for (const item of items) body.append(row(item, selected));
      results.replaceChildren(grid);
    }
    async function load() {
      clear();
      const request = new AbortController();
      controller = request;
      const selectedId = entry.technical_item_id;
      filters.hidden = Boolean(selectedId);
      try {
        if (selectedId) {
          if (!selectedItem || selectedItem.id !== selectedId) {
            const item = await get('/api/libraries/technical/' + encodeURIComponent(selectedId), request.signal);
            if (request.signal.aborted) return;
            selectedItem = item;
          }
          if (!request.signal.aborted) table([selectedItem], true);
          return;
        }
        const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value));
        const searching = query.size > 0;
        if (!definitions || searching) {
          query.set('limit', String(searching ? limit : 1));
          query.set('offset', String(offset));
          window.CeasefireI18n.text(status, 'Searching…');
          const data = await get('/api/libraries/technical?' + query, request.signal);
          if (request.signal.aborted) return;
          definitions = data.filters;
          window.CeasefireLibraries.renderFilterControls(filters, definitions, values, () => { offset = 0; load(); });
          if (searching) {
            if (!data.items.length) { window.CeasefireI18n.text(status, 'No matching records.'); return; }
            table(data.items);
            window.CeasefireI18n.text(status, 'Showing {0}–{1} of {2} records', [offset + 1, offset + data.items.length, data.total]);
            if (data.total > limit) {
              const previous = button('Previous', () => { offset -= limit; load(); });
              const next = button('Next', () => { offset += limit; load(); });
              previous.disabled = offset === 0;
              next.disabled = offset + limit >= data.total;
              pager.append(previous, next);
            }
            return;
          }
        }
        window.CeasefireI18n.text(status, definitions.length ? 'Select a filter to find a Technical Library item.' : 'Library unavailable.');
      } catch (error) {
        if (request.signal.aborted) return;
        if (selectedId) table([{id: selectedId}], true);
        status.textContent = error.message;
        pager.append(button('Refresh', load));
      }
    }
    async function get(url, signal) {
      const response = await fetch(url, {signal, headers: {Accept:'application/json'}});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || window.CeasefireI18n.translate('Records unavailable.'));
      return data;
    }
    load();
    return {element: section, close: () => controller?.abort()};
  }
  window.ClassifireRegisterLibrary = {picker};
})();
