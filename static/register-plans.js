(() => {
  'use strict';
  let dispose, remembered = new WeakMap();
  const sources = () => window.CeasefireEstimates.planSources();
  const key = source => source.project_id + '/' + source.document_id;
  const label = entry => entry.side1.id_number + (entry.access === 'Yes' ? ' / ' + entry.side2.id_number : '');
  const svgNS = 'http://www.w3.org/2000/svg';
  const translate = (source, args = []) => window.CeasefireI18n.translate(source, args);

  function exportContext(register) {
    const required = new Set(register.entries.flatMap(entry => (entry.plan_pins || []).map(pin => pin.project_id)));
    if (!required.size) return {};
    const sessions = Object.fromEntries(sources().filter(source => required.has(source.project_id))
      .map(source => [source.project_id, source.session_id]));
    return {plan_sessions:sessions};
  }

  function section({entry, entries, changed, el, field}) {
    dispose?.();
    const list = sources(), card = el('section','card register-plan-location');
    const controls = el('div','register-grid'), documents = el('select'), pages = el('select');
    const notice = el('p','helper'), sheet = el('button','register-plan-sheet'), canvas = el('canvas');
    const overlay = document.createElementNS(svgNS, 'svg');
    const pins = el('ul','register-plan-pins');
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
    sheet.type = 'button'; sheet.hidden = true; sheet.disabled = true;
    window.CeasefireI18n.attr(sheet, 'aria-label', 'Place pin on plan');
    overlay.setAttribute('aria-hidden', 'true');
    sheet.append(canvas, overlay);
    notice.setAttribute('aria-live', 'polite');
    card.append(notice, sheet, pins);
    let generation = 0, loading, renderTask, target = {x:.5, y:.5};
    const active = () => list.find(doc => key(doc) === documents.value);
    const pageNumber = () => Number(pages.value);
    const disposePreview = () => {
      generation++;
      renderTask?.cancel(); renderTask = null;
      if (loading) void loading.destroy().catch(() => {});
      loading = null; sheet.disabled = true; sheet.hidden = true;
    };
    dispose = disposePreview;

    function pinList() {
      pins.replaceChildren();
      for (const pin of entry.plan_pins || []) {
        const doc = list.find(item => key(item) === key(pin) && item.sha256 === pin.sha256);
        const row = el('li'), value = el('span');
        value.textContent = [doc?.name || translate('Drawing unavailable'), translate('Page {0}', [pin.page]), label(entry)].join(' · ');
        const remove = window.ClassifireFormControls.iconButton('Remove pin', 'remove', () => {
          entry.plan_pins = entry.plan_pins.filter(item => item !== pin);
          changed(); pinList(); drawMarks();
        });
        row.append(value, remove); pins.append(row);
      }
      pins.hidden = !pins.childElementCount;
    }
    function drawMarks() {
      overlay.replaceChildren();
      const doc = active();
      if (!doc || sheet.hidden) return;
      const w = canvas.width, h = canvas.height, scale = Math.min(w, h) / 550;
      overlay.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      function svg(tag, attrs) {
        const node = document.createElementNS(svgNS, tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
      }
      for (const row of entries.length ? entries : [entry]) {
        for (const pin of row.plan_pins || []) {
          if (pin.sha256 !== doc.sha256 || pin.page !== pageNumber()) continue;
          const x = pin.x * w, y = pin.y * h, nearRight = pin.x > .75;
          const mark = svg('g', {class:'register-plan-mark'});
          const dot = svg('circle', {cx:x, cy:y, r:4*scale, fill:'#c70027', stroke:'white', 'stroke-width':scale});
          const text = svg('text', {x:x + (nearRight ? -6 : 6)*scale, y:Math.max(12*scale, Math.min(h-2*scale, y)),
            'text-anchor':nearRight ? 'end' : 'start', 'font-size':12*scale, fill:'white', stroke:'#94001c',
            'stroke-width':3*scale, 'paint-order':'stroke', 'stroke-linejoin':'round'});
          text.textContent = label(row);
          mark.append(dot, text); overlay.append(mark);
        }
      }
      if (sheet.matches(':focus-visible')) {
        overlay.append(svg('circle', {cx:target.x*w, cy:target.y*h, r:6*scale, fill:'none', stroke:'#0072d6', 'stroke-width':2*scale}));
      }
    }
    function addPin(x, y) {
      if (sheet.disabled || !card.isConnected) return;
      const doc = active();
      if (!doc || !sources().some(item => item.session_id === doc.session_id && item.document_id === doc.document_id && item.sha256 === doc.sha256)) return;
      if ((entry.plan_pins?.length || 0) >= 200) {
        window.CeasefireI18n.text(notice, 'Each register entry supports up to 200 plan pins.'); return;
      }
      (entry.plan_pins ||= []).push({project_id:doc.project_id, document_id:doc.document_id, sha256:doc.sha256,
        page:pageNumber(), x:Math.max(0, Math.min(1, x)), y:Math.max(0, Math.min(1, y))});
      changed(); pinList(); drawMarks();
    }
    sheet.addEventListener('click', event => {
      if (!event.detail) { addPin(target.x, target.y); return; }
      const rect = canvas.getBoundingClientRect();
      if (rect.width && rect.height) addPin((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    });
    sheet.addEventListener('keydown', event => {
      const moves = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
      if (!moves[event.key]) return;
      event.preventDefault();
      const [dx,dy] = moves[event.key], step = event.shiftKey ? .05 : .005;
      target = {x:Math.max(0,Math.min(1,target.x + dx*step)), y:Math.max(0,Math.min(1,target.y + dy*step))};
      drawMarks();
    });
    sheet.addEventListener('focus', drawMarks); sheet.addEventListener('blur', drawMarks);

    async function showPage() {
      disposePreview(); notice.textContent = ''; overlay.replaceChildren(); target = {x:.5,y:.5};
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
        sheet.hidden = false; sheet.disabled = false;
        window.CeasefireI18n.text(notice, 'Click the plan to place a pin. With the keyboard, use the arrow keys and press Enter.');
        drawMarks();
      } catch (error) {
        if (token === generation) window.CeasefireI18n.text(notice, 'Drawing unavailable');
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
    pinList();
    changeDocument(selected?.page);
    return card;
  }
  window.ClassifireRegisterPlans = {section, exportContext, close() { dispose?.(); dispose = null; remembered = new WeakMap(); }};
})();
