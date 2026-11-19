(() => {
  'use strict';
  let dispose, remembered = new WeakMap();
  const sources = () => window.CeasefireEstimates.planSources();
  const key = source => source.project_id + '/' + source.document_id;
  const passiveLabel = window.ClassifirePassiveRegister.penetrationIds;
  const translate = (source, args = []) => window.CeasefireI18n.translate(source, args);
  const clamp = value => Math.max(0, Math.min(1, value));
  const moves = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};

  function exportContext(register) {
    const required = new Set(register.entries.flatMap(entry => (entry.plan_pins || []).map(pin => pin.project_id)));
    if (!required.size) return {};
    const sessions = Object.fromEntries(sources().filter(source => required.has(source.project_id))
      .map(source => [source.project_id, source.session_id]));
    return {plan_sessions:sessions};
  }

  function section({entry, entries, changed, el, field, label = passiveLabel}) {
    dispose?.();
    const list = sources(), card = el('section','card register-plan-location');
    const controls = el('div','register-grid register-plan-controls'), documents = el('select'), pages = el('select');
    const notice = el('p','helper'), sheet = el('div','register-plan-sheet'), canvas = el('canvas');
    const place = el('button','register-plan-canvas'), overlay = el('div','register-plan-marks');
    const remove = el('button','button secondary register-plan-delete','Delete');
    const missing = el('div','register-plan-unavailable');
    const lifetime = new AbortController();
    const selected = remembered.get(entry) || entry.plan_pins?.[0];
    documents.name = 'plan_source'; pages.name = 'plan_page';
    documents.add(new Option(translate('Select'), ''));
    for (const doc of list) documents.add(new Option(doc.name + ' · ' + doc.estimate, key(doc)));
    if (selected && list.some(doc => key(doc) === key(selected))) documents.value = key(selected);
    card.append(el('h2', '', 'Plan location'));
    if (list.length) {
      controls.append(field('Source document', documents), field('Page number', pages));
      card.append(controls);
    } else {
      card.append(el('p', 'helper', 'No PDFs uploaded'));
    }
    sheet.hidden = true;
    place.type = remove.type = 'button';
    remove.hidden = true;
    window.CeasefireI18n.attr(place, 'aria-label', 'Place pin on plan');
    const cursor = el('span','register-plan-cursor');
    cursor.setAttribute('aria-hidden','true');
    place.append(canvas,cursor);
    sheet.append(place, overlay, remove);
    notice.setAttribute('aria-live', 'polite');
    card.append(notice, sheet, missing);
    let generation = 0, loading, renderTask, menuPin, failedDoc, target = {x:.5, y:.5};
    const active = () => list.find(doc => key(doc) === documents.value);
    const pageNumber = () => Number(pages.value);
    const disposePreview = () => {
      generation++;
      renderTask?.cancel(); renderTask = null;
      if (loading) void loading.destroy().catch(() => {});
      loading = null; sheet.hidden = true; closeMenu();
    };
    dispose = () => { lifetime.abort(); disposePreview(); };

    function closeMenu() { menuPin = null; remove.hidden = true; }
    function deletePin(pin) {
      if (!entry.plan_pins?.includes(pin)) return;
      entry.plan_pins = entry.plan_pins.filter(item => item !== pin);
      closeMenu(); changed(); drawMarks(); showInstructions(); showUnavailable();
    }
    function showUnavailable() {
      // An old project can retain a pin after its source file was removed.
      // Keep it recoverable even though there is no drawing to right-click.
      missing.replaceChildren();
      for (const pin of entry.plan_pins || []) {
        const doc = list.find(item => key(item) === key(pin) && item.sha256 === pin.sha256 && pin.page <= item.pages);
        if (doc && !(doc === failedDoc && pin.page === pageNumber())) continue;
        const warning = el('div','register-plan-unavailable-row');
        const description = el('span');
        description.textContent = [translate('Drawing unavailable'), doc?.name, translate('Page {0}', [pin.page]), label(entry)].filter(Boolean).join(' · ');
        warning.append(description, window.ClassifireFormControls.iconButton('Remove pin', 'remove', () => deletePin(pin)));
        missing.append(warning);
      }
    }
    function showInstructions() {
      if (sheet.hidden) return;
      const pin = entry.plan_pins?.[0];
      place.disabled = Boolean(pin);
      if (!pin) {
        window.CeasefireI18n.text(notice, 'Click the plan to place a pin. With the keyboard, use the arrow keys and press Enter.');
      } else {
        const here = entry.plan_pins.some(p => p.sha256 === active()?.sha256 && p.page === pageNumber());
        if (here) window.CeasefireI18n.text(notice, 'Drag the pin to move it. Right-click or tap it to delete.');
        else {
          const doc = list.find(item => key(item) === key(pin) && item.sha256 === pin.sha256);
          notice.textContent = [label(entry), doc?.name || translate('Drawing unavailable'), translate('Page {0}', [pin.page])].join(' · ');
        }
      }
    }
    function position(mark, point) {
      mark.style.left = (point.x * 100) + '%';
      mark.style.top = (point.y * 100) + '%';
      mark.classList.toggle('near-right', point.x > .75);
    }
    function openMenu(pin, mark) {
      menuPin = pin;
      remove.hidden = false;
      const rect = sheet.getBoundingClientRect();
      remove.style.left = Math.max(0, Math.min(rect.width - remove.offsetWidth, pin.x * rect.width + 4)) + 'px';
      remove.style.top = Math.max(0, Math.min(rect.height - remove.offsetHeight, pin.y * rect.height + 10)) + 'px';
      remove.focus({preventScroll:true});
      remove.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(); mark.focus({preventScroll:true}); }
      };
    }
    remove.addEventListener('click', () => { deletePin(menuPin); place.focus({preventScroll:true}); });
    remove.addEventListener('blur', closeMenu);
    document.addEventListener('pointerdown', event => {
      if (event.target !== remove) closeMenu();
    }, {capture:true, signal:lifetime.signal});

    function makeMark(row, pin) {
      const own = row === entry;
      const mark = el(own ? 'button' : 'span','register-plan-mark');
      mark.textContent = label(row);
      position(mark, pin);
      if (!own) return mark;
      mark.type = 'button';
      mark.addEventListener('contextmenu', event => { event.preventDefault(); openMenu(pin, mark); });
      mark.addEventListener('keydown', event => {
        const move = moves[event.key];
        if (move) {
          event.preventDefault();
          const step = event.shiftKey ? .05 : .005;
          pin.x = clamp(pin.x + move[0] * step); pin.y = clamp(pin.y + move[1] * step);
          position(mark,pin); changed();
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); openMenu(pin,mark);
        } else if (event.key === 'Delete') {
          event.preventDefault(); deletePin(pin); place.focus({preventScroll:true});
        }
      });
      let drag, moved = false;
      mark.addEventListener('pointerdown', event => {
        if (drag || event.button !== 0 || !event.isPrimary) return;
        moved = false;
        drag = {id:event.pointerId, startX:event.clientX, startY:event.clientY, point:pin, bounds:canvas.getBoundingClientRect()};
        mark.setPointerCapture(event.pointerId);
      });
      function preview(event) {
        const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
        if (!moved && Math.hypot(dx,dy) < 3) return;
        moved = true;
        drag.point = {x:clamp(pin.x + dx / drag.bounds.width), y:clamp(pin.y + dy / drag.bounds.height)};
        position(mark,drag.point);
      }
      mark.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) preview(event); });
      mark.addEventListener('pointerup', event => {
        if (drag?.id !== event.pointerId) return;
        preview(event);
        if (moved) { Object.assign(pin,drag.point); changed(); }
        drag = null;
      });
      mark.addEventListener('lostpointercapture', () => {
        if (drag) { drag = null; position(mark,pin); }
      });
      mark.addEventListener('click', event => {
        if (!moved || !event.detail) openMenu(pin,mark);
        moved = false;
      });
      return mark;
    }
    function drawMarks() {
      overlay.replaceChildren();
      const doc = active();
      if (!doc || sheet.hidden) return;
      // Put this entry's button above any neighbouring callouts.
      for (const row of [...entries.filter(item => item !== entry), entry]) {
        for (const pin of row.plan_pins || []) {
          if (pin.sha256 !== doc.sha256 || pin.page !== pageNumber()) continue;
          overlay.append(makeMark(row,pin));
        }
      }
      position(cursor,target);
    }
    function addPin(x, y) {
      if (entry.plan_pins?.length || place.matches(':disabled') || sheet.hidden || !card.isConnected) return;
      const doc = active();
      if (!doc || !sources().some(item => item.session_id === doc.session_id && item.document_id === doc.document_id && item.sha256 === doc.sha256)) return;
      entry.plan_pins = [{project_id:doc.project_id, document_id:doc.document_id, sha256:doc.sha256,
        page:pageNumber(), x:clamp(x), y:clamp(y)}];
      changed(); drawMarks(); showInstructions();
      overlay.querySelector('button')?.focus({preventScroll:true});
    }
    place.addEventListener('click', event => {
      if (!event.detail) { addPin(target.x, target.y); return; }
      const rect = canvas.getBoundingClientRect();
      if (rect.width && rect.height) addPin((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    });
    place.addEventListener('keydown', event => {
      if (!moves[event.key]) return;
      event.preventDefault();
      const [dx,dy] = moves[event.key], step = event.shiftKey ? .05 : .005;
      target = {x:clamp(target.x + dx*step), y:clamp(target.y + dy*step)};
      position(cursor,target);
    });

    async function showPage() {
      disposePreview(); notice.textContent = ''; overlay.replaceChildren(); target = {x:.5,y:.5}; failedDoc = null; showUnavailable();
      const doc = active(), number = pageNumber(), token = generation;
      if (!doc || !number) return;
      remembered.set(entry, {...doc, page:number});
      try {
        const lib = await import('/vendor/pdfjs/build/pdf.mjs');
        if (generation !== token || !card.isConnected) return;
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
        loading = lib.getDocument({url:'/api/takeoffs/sessions/' + doc.session_id + '/documents/' + doc.document_id + '/file',
          cMapUrl:'/vendor/pdfjs/cmaps/', cMapPacked:true, standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',
          wasmUrl:'/vendor/pdfjs/wasm/', iccUrl:'/vendor/pdfjs/iccs/', useWasm:false, isEvalSupported:false,
          enableXfa:false, disableFontFace:true, maxImageSize:64000000, canvasMaxAreaInBytes:64000000,
          disableAutoFetch:true, disableStream:true, stopAtErrors:true});
        const pdf = await loading.promise;
        if (generation !== token) return;
        const page = await pdf.getPage(number);
        if (generation !== token) return;
        const base = page.getViewport({scale:1}), scale = 1600 / Math.max(base.width, base.height);
        const viewport = page.getViewport({scale});
        canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
        renderTask = page.render({canvasContext:canvas.getContext('2d'), viewport});
        await renderTask.promise;
        if (generation !== token || !card.isConnected) return;
        sheet.hidden = false;
        drawMarks(); showInstructions();
      } catch (error) {
        if (token === generation) { failedDoc = doc; window.CeasefireI18n.text(notice, 'Drawing unavailable'); showUnavailable(); }
      }
    }
    function changeDocument(page = 1) {
      const doc = active();
      pages.replaceChildren();
      if (doc) for (let n = 1; n <= doc.pages; n++) pages.add(new Option(String(n), String(n)));
      pages.disabled = !doc; pages.value = String(page);
      void showPage();
    }
    documents.addEventListener('change', () => changeDocument());
    pages.addEventListener('change', showPage);
    changeDocument(selected?.page);
    return card;
  }
  window.ClassifireRegisterPlans = {section, exportContext, close() { dispose?.(); dispose = null; remembered = new WeakMap(); }};
})();
