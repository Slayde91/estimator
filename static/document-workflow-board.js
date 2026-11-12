(() => {
  'use strict';
  const stages = Object.freeze(['Draft', 'Review', 'Approved', 'Rejected']);
  function render(host, {items, stageOf, cardFor, move, locked, onError, legacy=[], stages:boardStages=stages, emptyLabel="No documents"}) {
    const columns = [...boardStages, ...legacy.filter(stage => items.some(row => stageOf(row) === stage))];
    let dragging = null;
    host.replaceChildren();
    const board = document.createElement('div');
    board.className = 'project-kanban document-workflow-board';
    host.append(board);
    for (const stage of columns) {
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
      if (boardStages.includes(stage)) {
        column.addEventListener('dragover', event => {if (dragging && !locked()) event.preventDefault();});
        column.addEventListener('drop', event => {
          if (!dragging || locked()) return;
          event.preventDefault();
          const row = dragging; dragging = null;
          if (stageOf(row) !== stage) Promise.resolve().then(() => move(row, stage)).catch(onError);
        });
      }
      if (boardStages.includes(stage)) board.append(column);
      else {
        const historical = document.createElement('div');
        historical.className = 'document-workflow-board document-workflow-history';
        historical.append(column); host.append(historical);
      }
    }
  }
  window.ClassifireDocumentBoard = {stages, render};
})();
