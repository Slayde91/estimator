(() => {
  'use strict';
  const views = new Map();
  function viewFor(workspace) {
    if (!views.has(workspace)) {
      let saved;
      try { saved = localStorage.getItem('classifire.register-view.' + workspace); } catch {}
      views.set(workspace, saved === 'table' ? 'table' : 'kanban');
    }
    return views.get(workspace);
  }
  function label(tag, source) {
    const element = document.createElement(tag);
    element.textContent = source;
    window.CeasefireI18n?.text(element, source);
    return element;
  }
  function viewPicker(workspace, onChange) {
    const field = document.createElement('div'), caption = label('span', 'View');
    field.className = 'field record-view-picker';
    caption.id = 'register-view-label-' + workspace;
    const menu = document.createElement('details'), toggle = document.createElement('summary');
    menu.className = 'commercial-columns-menu';
    toggle.className = 'button secondary';
    const icon = document.createElement('i'), current = document.createElement('span'), arrow = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    current.id = 'register-view-value-' + workspace;
    toggle.setAttribute('aria-labelledby', caption.id + ' ' + current.id);
    arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true');
    toggle.append(icon, current, arrow);
    const options = document.createElement('div');
    options.className = 'commercial-menu-options';
    for (const [value, name] of [['table', 'Table'], ['kanban', 'Kanban']]) {
      const option = document.createElement('button'), symbol = document.createElement('i');
      option.type = 'button'; option.className = 'text-button'; option.value = value;
      symbol.dataset.viewIcon = value; symbol.setAttribute('aria-hidden', 'true');
      option.append(label('span', name), symbol);
      option.addEventListener('click', () => {
        menu.open = false;
        if (value !== viewFor(workspace)) {
          views.set(workspace, value);
          try { localStorage.setItem('classifire.register-view.' + workspace, value); } catch {}
          refresh();
          onChange();
        }
        toggle.focus();
      });
      options.append(option);
    }
    function refresh() {
      const value = viewFor(workspace), source = value === 'table' ? 'Table' : 'Kanban';
      icon.dataset.viewIcon = value;
      current.textContent = source; window.CeasefireI18n?.text(current, source);
      for (const option of options.children) option.setAttribute('aria-pressed', String(option.value === value));
    }
    refresh();
    menu.append(toggle, options); field.append(caption, menu);
    return field;
  }
  function recordTable(headers, items, fillRow) {
    const wrapper = document.createElement('div'), table = document.createElement('table');
    wrapper.className = 'table-scroll record-list-table';
    const header = table.createTHead().insertRow();
    for (const title of headers) {
      const cell = label('th', title);
      cell.scope = 'col'; header.append(cell);
    }
    const body = table.createTBody();
    for (const item of items) {
      const row = body.insertRow();
      for (const value of fillRow(item, row)) row.insertCell().append(value || '—');
    }
    if (!items.length) {
      const empty = body.insertRow().insertCell();
      empty.colSpan = headers.length; empty.append(label('span', 'No matching records.'));
    }
    wrapper.append(table);
    return wrapper;
  }
  function render(host, {items, stages, stageOf, cardFor, move, locked, onError, emptyLabel}) {
    let dragging = null;
    host.replaceChildren();
    const board = document.createElement('div');
    board.className = 'project-kanban document-workflow-board';
    host.append(board);
    for (const stage of stages) {
      const rows = items.filter(row => stageOf(row) === stage);
      const column = document.createElement('section'), header = document.createElement('div');
      column.className = 'project-kanban-column'; column.dataset.status = stage;
      header.className = 'project-column-heading';
      const heading = document.createElement('h2'), count = document.createElement('span');
      heading.textContent = stage; window.CeasefireI18n?.text(heading, stage);
      count.className = 'badge'; count.textContent = rows.length;
      header.append(heading, count); column.append(header);
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'project-column-empty'; empty.textContent = emptyLabel;
        window.CeasefireI18n?.text(empty, emptyLabel); column.append(empty);
      }
      for (const row of rows) {
        const card = cardFor(row);
        card.draggable = true;
        card.addEventListener('dragstart', event => {
          if (locked() || event.target.closest('button,select,input,summary,a')) {event.preventDefault(); return;}
          dragging = row; event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-classifire-review-card', row.id);
        });
        card.addEventListener('dragend', () => { dragging = null; });
        column.append(card);
      }
      column.addEventListener('dragover', event => {if (dragging && !locked()) event.preventDefault();});
      column.addEventListener('drop', event => {
        if (!dragging || locked()) return;
        event.preventDefault();
        const row = dragging; dragging = null;
        if (stageOf(row) !== stage) Promise.resolve().then(() => move(row, stage)).catch(onError);
      });
      board.append(column);
    }
  }
  let followUpTimer;
  function addFollowUpMarker(card, date, onClick) {
    if (!date) return;
    const marker = document.createElement('button');
    marker.className = 'board-follow-up-due'; marker.textContent = '!'; marker.hidden = true;
    marker.dataset.followUpDate = date;
    marker.type = 'button'; marker.setAttribute('aria-haspopup', 'dialog');
    marker.setAttribute('aria-label', 'Follow-up due'); marker.title = 'Follow-up due';
    marker.addEventListener('click', onClick);
    window.CeasefireI18n?.attr(marker, 'aria-label', 'Follow-up due');
    window.CeasefireI18n?.attr(marker, 'title', 'Follow-up due');
    card.append(marker);
    return marker;
  }
  function refreshFollowUps() {
    clearTimeout(followUpTimer);
    if (document.hidden) return;
    const visible = [...document.querySelectorAll('.board-follow-up-due')].filter(marker => !marker.parentElement.closest('[hidden]'));
    if (!visible.length) return;
    const today = window.CeasefireScheduler.organizationToday();
    for (const marker of visible) marker.hidden = marker.dataset.followUpDate > today;
    followUpTimer = setTimeout(refreshFollowUps, 60000 - Date.now() % 60000);
  }
  document.addEventListener('visibilitychange', refreshFollowUps);
  window.addEventListener('pageshow', refreshFollowUps);
  window.addEventListener('ceasefire:organization-timezone-changed', refreshFollowUps);
  window.ClassifireDocumentBoard = {render, viewFor, viewPicker, recordTable, addFollowUpMarker, refreshFollowUps};
})();
