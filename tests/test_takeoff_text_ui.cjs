// Text extraction is independent from drawing proof and cannot publish stale pages.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness() {
  const requests = [], tasks = [], copied = [];
  function element() { return { style: {}, dataset: {}, children: [], classList: { toggle() {} }, setAttribute() {}, append(child) { this.children.push(child); child.connected = true; }, remove() { this.connected = false; }, contains(value) { return value === this; } }; }
  const selection = { anchorNode: null, focusNode: null, removeAllRanges() { this.anchorNode = this.focusNode = null; } };
  const context = { window: { getSelection: () => selection }, document: { createElement: element, getElementById() {} }, console };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit={state,ensurePdfTextLayer,clearPdfTextLayer,clearPdfTextSelection,positionPdfTextLayer,planKeydown,planContextMenu,
    lib(value){pdfLibrary=async()=>value;boundedPdf=promise=>promise;},copy(fn){copyLengthMarkups=fn;},cancel(fn){cancelTrace=fn;}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context); const { audit } = context, { state } = audit;
  const dims = { pageX: 20, pageY: 30, pageWidth: 780, pageHeight: 540 };
  const page = { getViewport() { return { rawDims: dims }; }, getTextContent() { const request = deferred(); requests.push(request); return request.promise; } };
  const lib = { TextLayer: class { constructor(options) { this.options = options; this.completion = deferred(); tasks.push(this); } render() { return this.completion.promise; } cancel() { this.cancelled = true; } } };
  audit.lib(lib); audit.copy(() => copied.push(true));
  Object.assign(state, { session: { session_id: 's' }, document: 'd', page: 1, tool: 'text', selected: new Set(['selected-markup']),
    displayKey: JSON.stringify(['s', 'd', 1, 0]), displayPage: page, viewport: { transform: [0, 2, 2, 0, -60, -40] }, ui: { pageWrap: element(), progress: element() } });
  return { audit, state, selection, requests, tasks, copied, page };
}
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check('Native text follows the current crop/rotation/UserUnit transform and retains spans during zoom', async () => {
    const h = harness(), pending = h.audit.ensurePdfTextLayer(); await flush();
    h.requests[0].resolve({ items: [{ str: 'Original only' }] }); await flush(); h.tasks[0].completion.resolve(); await pending;
    const layer = h.state.pdfText.container; assert.equal(layer.style.transform, 'matrix(0,2,-2,0,1080,0)');
    assert.equal(layer.style.width, '780px'); assert.equal(layer.style.height, '540px');
    h.selection.anchorNode = layer; h.selection.focusNode = layer;
    h.state.viewport.transform = [0, 3, 3, 0, -90, -60]; h.audit.positionPdfTextLayer(); await h.audit.ensurePdfTextLayer();
    assert.equal(h.state.pdfText.container, layer); assert.equal(h.requests.length, 1); assert.equal(layer.style.transform, 'matrix(0,3,-3,0,1620,0)'); assert.equal(h.selection.anchorNode, layer);
  });
  await check('A prior page extraction cannot append text after navigation', async () => {
    const h = harness(), pending = h.audit.ensurePdfTextLayer(); await flush(); h.audit.clearPdfTextLayer(); h.state.page = 2; h.state.displayKey = JSON.stringify(['s', 'd', 2, 0]);
    h.requests[0].resolve({ items: [{ str: 'Old page' }] }); await pending; assert.equal(h.tasks.length, 0); assert.equal(h.state.ui.pageWrap.children.length, 0); assert.equal(h.state.pdfText, null);
  });
  await check('Zoom stays available while text is loading and completion uses the latest display transform', async () => {
    const h = harness(), pending = h.audit.ensurePdfTextLayer(); await flush();
    h.state.viewport.transform = [0, 4, 4, 0, -120, -80]; h.audit.positionPdfTextLayer();
    h.requests[0].resolve({ items: [{ str: 'Slow native text' }] }); await flush(); h.tasks[0].completion.resolve(); await pending;
    assert.equal(h.state.pdfText.container.style.transform, 'matrix(0,4,-4,0,2160,0)');
  });
  await check('A late text-layout completion cannot replace another page or resurrect selection', async () => {
    const h = harness(), pending = h.audit.ensurePdfTextLayer(); await flush(); h.requests[0].resolve({ items: [{ str: 'Old page' }] }); await flush();
    h.audit.clearPdfTextLayer(); h.tasks[0].completion.resolve(); await pending; assert.equal(h.tasks[0].cancelled, true); assert.equal(h.state.ui.pageWrap.children.length, 0);
  });
  await check('Text-only failure leaves the successfully rendered drawing usable', async () => {
    const h = harness(), viewport = h.state.viewport, pending = h.audit.ensurePdfTextLayer(); await flush(); h.requests[0].reject(new Error('Text extraction failed')); await pending;
    assert.equal(h.state.pdfText.status, 'error'); assert.equal(h.state.viewport, viewport); assert.equal(h.state.displayPage, h.page); assert.match(h.state.ui.progress.textContent, /original drawing remains visible/);
  });
  await check('Image-only pages report no native text without manufacturing spans', async () => {
    const h = harness(), pending = h.audit.ensurePdfTextLayer(); await flush(); h.requests[0].resolve({ items: [] }); await flush(); h.tasks[0].completion.resolve(); await pending;
    assert.equal(h.state.pdfText.status, 'empty'); assert.match(h.state.ui.progress.textContent, /no selectable PDF text/);
  });
  await check('Text tool preserves native copy even while markups remain selected', async () => {
    const h = harness(); let prevented = false; h.audit.planKeydown({ key: 'c', ctrlKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, false); assert.equal(h.copied.length, 0);
    h.state.tool = 'select'; h.audit.planKeydown({ key: 'c', ctrlKey: true, preventDefault() { prevented = true; } }); await flush(); assert.equal(prevented, true); assert.equal(h.copied.length, 1);
  });
  await check('Text right-click preserves the native Copy menu and selection while drawing right-click still cancels', async () => {
    const h = harness(), selectedText = {}; let cancelled = 0, prevented = false;
    h.selection.anchorNode = h.selection.focusNode = selectedText;
    h.audit.cancel(() => { cancelled++; h.selection.removeAllRanges(); h.state.tool = 'select'; });
    const event = { preventDefault() { prevented = true; } };
    h.audit.planContextMenu(event);
    assert.equal(prevented, false); assert.equal(cancelled, 0); assert.equal(h.state.tool, 'text');
    assert.equal(h.selection.anchorNode, selectedText); assert.equal(h.selection.focusNode, selectedText); assert.equal(h.state.selected.size, 1);
    h.state.tool = 'trace'; h.state.points = [[10, 10]]; h.audit.planContextMenu(event);
    assert.equal(prevented, true); assert.equal(cancelled, 1); assert.equal(h.state.tool, 'select');
  });
  await check('Selection cleanup leaves text selected outside the drawing alone', async () => {
    const h = harness(), outside = {}; h.state.pdfText = { container: { contains: value => value === 'pdf' } };
    h.selection.anchorNode = outside; h.selection.focusNode = outside; h.audit.clearPdfTextSelection(); assert.equal(h.selection.anchorNode, outside);
    h.selection.anchorNode = 'pdf'; h.audit.clearPdfTextSelection(); assert.equal(h.selection.anchorNode, null);
  });
  console.log(`${passed} native PDF text checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
