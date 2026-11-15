(() => {
  'use strict';

  const facets = ['substrate', 'orientation', 'manufacturer', 'type', 'category', 'services', 'frl'];
  const emptyFilters = () => Object.fromEntries(facets.map(key => [key, '']));

  function picker(entry, onSelect, options, customFields) {
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
    const mode = element('label'), custom = element('input'), manualFields = element('div');
    mode.className = 'register-custom-mode';
    manualFields.className = 'register-manual-fields';
    custom.type = 'checkbox';
    const legacy = !('technical_item_id' in entry);
    custom.checked = Boolean(entry.custom_entry || legacy);
    mode.append(custom, element('span','Custom entry'));
    section.append(element('h2', 'Technical Library'), mode, filters, manualFields, status, results, pager);
    const limit = 20;
    const values = {...emptyFilters(), ...entry.technical_filters};
    if (legacy) {
      for (const key of ['substrate','orientation','manufacturer','frl']) values[key] = entry[key] || '';
    }
    let offset = 0, controller, definitions, selectedItem;
    let typingManufacturer = false;
    const manualOption = '__enter_manufacturer__';

    function saveFilters() {
      entry.technical_item_id = '';
      entry.technical_filters = {...values};
      entry.custom_entry = custom.checked;
      selectedItem = null;
      offset = 0;
      onSelect();
    }
    custom.addEventListener('change', () => {
      if (!custom.checked && typingManufacturer) values.manufacturer = '';
      typingManufacturer = false;
      saveFilters();
      load();
    });

    function updateReportOptions() {
      const report = manualFields.querySelector('input[name="report"]');
      if (!report) return;
      const manufacturer = values.manufacturer.trim().toLowerCase();
      const key = Object.keys(options.reports).find(name => name.toLowerCase() === manufacturer);
      report.required = Boolean(key);
      manualFields.querySelector('datalist').replaceChildren(...(options.reports[key] || []).map(value => new Option(value, value)));
    }

    function renderFilters() {
      const display = {...values};
      const filtersForMode = definitions.map(filter => {
        // Older manual inspections used these authored choices, some of which
        // aren't catalogued systems. Keep them available in the manual editor.
        if (!custom.checked || !['substrate','orientation','manufacturer','frl'].includes(filter.key)) return filter;
        const choices = [...filter.options];
        const seen = new Set(choices.map(opt => opt.value.toLowerCase()));
        for (const value of options[filter.key] || []) {
          if (!seen.has(value.toLowerCase())) choices.push({value,label:value});
        }
        return {...filter, options:choices};
      });
      const manufacturer = filtersForMode.find(filter => filter.key === 'manufacturer');
      if (custom.checked && values.manufacturer && !manufacturer?.options.some(opt => opt.value === values.manufacturer))
        typingManufacturer = true;
      if (typingManufacturer) display.manufacturer = '';
      window.CeasefireLibraries.renderFilterControls(filters, filtersForMode, display, () => {
        const previousManufacturer = values.manufacturer;
        const manual = display.manufacturer === manualOption;
        Object.assign(values, display);
        if (manual) {
          values.manufacturer = typingManufacturer ? previousManufacturer : '';
          custom.checked = true;
        }
        if (previousManufacturer !== values.manufacturer) entry.report = '';
        typingManufacturer = manual;
        saveFilters();
        load();
        if (manual && !values.manufacturer) filters.querySelector('input')?.focus();
      });
      for (const select of filters.querySelectorAll('select')) select.required = true;
      const choice = filters.querySelector('[data-library-filter="manufacturer"]');
      if (choice) {
        const option = element('option', 'Enter custom manufacturer');
        option.value = manualOption;
        choice.add(option);
        if (typingManufacturer) {
          choice.value = manualOption;
          display.manufacturer = manualOption;
          const label = element('label'), input = element('input');
          label.className = 'field';
          input.maxLength = 1000;
          input.required = true;
          input.value = values.manufacturer;
          input.addEventListener('input', () => {
            values.manufacturer = input.value;
            entry.report = '';
            const report = manualFields.querySelector('input[name="report"]');
            if (report) report.value = '';
            saveFilters();
          });
          input.addEventListener('change', updateReportOptions);
          label.append(element('span','Manufacturer name'), input);
          choice.parentElement.after(label);
        }
      }
      manualFields.replaceChildren(...(custom.checked ? customFields(entry) : []));
      updateReportOptions();
    }

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
      check.disabled = !selected && facets.some(key => !values[key]);
      const title = window.LibraryDetailText.displayTitle(item);
      check.setAttribute('aria-label', title);
      check.dataset.technicalItemId = item.id;
      check.addEventListener('change', () => {
        selectedItem = check.checked ? item : null;
        entry.technical_item_id = check.checked ? item.id : '';
        entry.technical_filters = {...values};
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
          if (!request.signal.aborted) {
            table([selectedItem], true);
            if ('services' in (entry.technical_filters || {}) && facets.some(key => !values[key])) {
              window.CeasefireI18n.text(status, 'Uncheck this item to complete the seven filters.');
            }
          }
          return;
        }
        const query = new URLSearchParams(custom.checked ? [] : Object.entries(values).filter(([, value]) => value));
        const searching = query.size > 0;
        let data;
        if (!definitions || searching) {
          query.set('inspection', '1');
          query.set('limit', String(searching ? limit : 1));
          query.set('offset', String(offset));
          window.CeasefireI18n.text(status, 'Searching…');
          data = await get('/api/libraries/technical?' + query, request.signal);
          if (request.signal.aborted) return;
          definitions = data.filters.filter(filter => facets.includes(filter.key));
        }
        renderFilters();
        if (custom.checked) return;
        if (searching) {
          if (!data.items.length) { window.CeasefireI18n.text(status, 'No matching records.'); return; }
          table(data.items);
          if (facets.every(key => values[key])) {
            window.CeasefireI18n.text(status, 'Showing {0}–{1} of {2} records', [offset + 1, offset + data.items.length, data.total]);
          } else window.CeasefireI18n.text(status, 'Choose all seven filters to select a Technical Library item.');
          if (data.total > limit) {
            const previous = button('Previous', () => { offset -= limit; load(); });
            const next = button('Next', () => { offset += limit; load(); });
            previous.disabled = offset === 0;
            next.disabled = offset + limit >= data.total;
            pager.append(previous, next);
          }
          return;
        }
        window.CeasefireI18n.text(status, definitions.length ? 'Choose all seven filters to select a Technical Library item.' : 'Library unavailable.');
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
  window.ClassifireRegisterLibrary = {picker, emptyFilters};
})();
