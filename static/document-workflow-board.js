(() => {
  'use strict';
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
  window.ClassifireDocumentBoard = {render, addFollowUpMarker, refreshFollowUps};
})();
