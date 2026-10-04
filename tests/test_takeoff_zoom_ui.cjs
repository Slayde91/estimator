// Exercise the real PDF display/zoom lifecycle with independently controlled
// animation frames and PDF renders; no browser timing or supplier file required.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const geometry = require('../static/takeoff-geometry.js');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function harness() {
  const frames = new Map(), timers = new Map(), renders = [], commands = [], overlays = [];
  let nextId = 0;
  function element(tag = 'div') {
    return { tagName: tag.toUpperCase(), style: {}, attributes: {}, dataset: {}, children: [], events: {}, textContent: '',
      setAttribute(name, value) { this.attributes[name] = String(value); },
      append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
      replaceWith(value) { this.replacement = value; }, getContext() { return {}; },
      classList: { toggle() {} }, addEventListener(type, fn) { this.events[type] = fn; },
      removeEventListener(type, fn) { if (this.events[type] === fn) delete this.events[type]; },
      setPointerCapture() {}, hasPointerCapture() { return false; }, querySelectorAll() { return []; }
    };
  }
  const context = { window: { CeasefireTakeoffGeometry: geometry, requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; }, cancelAnimationFrame(id) { frames.delete(id); } },
    document: { getElementById() { return null; }, createElement: element, createElementNS: (_, tag) => element(tag) },
    console, crypto: require('node:crypto'), setTimeout(fn, delay) { timers.set(++nextId, { fn, delay }); return nextId; }, clearTimeout(id) { timers.delete(id); } };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit = {state,zoomBy,renderPage,fitPage,rotatePage,pageViewport,pageRotation,displayViewport,pageDisplayKey,cancelQueuedZoom,drawingPoint,positionPage,beginPan,recordPdfFailure,releaseDocuments,
    setPdf(fn){pdfDocument=async()=>({});pdfPage=async(...args)=>fn(args[2]);},setCommand(fn){command=fn;},setOverlay(fn){renderOverlay=fn;},stopSideWork(){autoCalibratePage=async()=>{};renderThumbnails=async()=>{};}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const audit = context.audit, state = audit.state, ui = {};
  for (const key of ['canvas', 'overlay', 'pageWrap', 'panSpace', 'viewport', 'page', 'pageCount', 'progress', 'zoom', 'empty', 'message']) ui[key] = element();
  Object.assign(ui.viewport, { clientWidth: 500, clientHeight: 400, clientLeft: 2, clientTop: 2, scrollLeft: 0, scrollTop: 0, getBoundingClientRect() { return { left: 10, top: 20, width: 504, height: 404 }; } });
  const bounds = () => ({ left: 12 + parseFloat(ui.pageWrap.style.left || 0) - ui.viewport.scrollLeft, top: 22 + parseFloat(ui.pageWrap.style.top || 0) - ui.viewport.scrollTop, width: state.viewport?.width || 200, height: state.viewport?.height || 300 });
  ui.overlay.getBoundingClientRect = bounds; ui.pageWrap.getBoundingClientRect = bounds;
  const page = { getViewport({ scale }) { return { width: 200 * scale, height: 300 * scale, transform: [scale, 0, 0, -scale, 0, 300 * scale] }; },
    render(options) { const task = { ...deferred(), options, cancelled: false, cancel() { this.cancelled = true; } }; renders.push(task); return task; } };
  Object.assign(state, { ui, session: { session_id: 'session', revision: 0, snapshot: { documents: [{ id: 'doc', name: 'Original.pdf', sha256: 'a'.repeat(64), pages: [{ page: 1 }, { page: 2 }] }], items: [], calibrations: [], render_checks: [] } }, document: 'doc', page: 1, displayPage: page, viewport: page.getViewport({ scale: 1 }), zoom: 1 });
  state.displayKey = audit.pageDisplayKey(); state.planContextKey = JSON.stringify(['session', 'doc', 1, 'steel', 0]);
  audit.setOverlay(() => overlays.push(copy(state.viewport))); audit.stopSideWork(); audit.setPdf(() => page);
  audit.setCommand(async (op, payload, guard) => { if (!guard || guard()) commands.push({ op, ...copy(payload) }); });
  audit.displayViewport(state.viewport, null); overlays.length = 0;
  return { audit, context, state, ui, page, frames, timers, renders, commands, overlays,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    timer(delay) { for (const [id, task] of [...timers]) if (task.delay === delay) { timers.delete(id); task.fn(); } },
    async finish(task = renders.at(-1)) { task.resolve(); await flush(); },
    point(client) { return audit.drawingPoint({ clientX: client[0], clientY: client[1] }); }
  };
}

let passed = 0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check('Rapid zoom inputs share one anchored preview and one settled PDF render', async () => {
    const h = harness(), client = [210, 170], point = copy(h.point(client)), canvas = h.ui.canvas;
    await h.audit.zoomBy(1.2, client); await h.audit.zoomBy(1.2, client);
    assert.equal(h.frames.size, 1); assert.equal(h.renders.length, 0); assert.equal(h.state.viewport.width, 200);
    h.frame(); near(h.state.zoom, 1.44); near(h.state.viewport.width, 288); near(h.point(client)[0], point[0]); near(h.point(client)[1], point[1]);
    assert.equal(h.ui.canvas, canvas); assert.equal(h.overlays.length, 1); assert.equal(h.ui.canvas.style.width, `${h.state.viewport.width}px`);
    h.timer(120); await flush(); assert.equal(h.renders.length, 1); assert.equal(h.ui.canvas, canvas); assert.ok(h.state.viewport);
    await h.finish(); assert.notEqual(h.ui.canvas, canvas); assert.equal(h.commands.length, 1); assert.equal(h.commands[0].success, true);
  });
  await check('A newer zoom invalidates an older bitmap immediately and only the latest render replaces it', async () => {
    const h = harness(), canvas = h.ui.canvas;
    await h.audit.zoomBy(2, [200, 150]); h.frame(); h.timer(120); await flush(); const old = h.renders[0];
    await h.audit.zoomBy(.75, [200, 150]); assert.equal(old.cancelled, true); h.frame();
    await h.finish(old); assert.equal(h.ui.canvas, canvas); assert.equal(h.commands.length, 0);
    h.timer(120); await flush(); assert.equal(h.renders.length, 2); await h.finish();
    assert.equal(h.ui.canvas.width, 300); assert.equal(h.state.viewport.width, 300); assert.equal(h.commands.length, 1);
  });
  await check('Refinement swaps the bitmap without moving a page panned while it was rendering', async () => {
    const h = harness(); await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.timer(120); await flush();
    h.audit.positionPage(-80.125, 32.5); const before = { scrollLeft: h.ui.viewport.scrollLeft, scrollTop: h.ui.viewport.scrollTop, left: h.ui.pageWrap.style.left, top: h.ui.pageWrap.style.top };
    await h.finish(); assert.deepEqual({ scrollLeft: h.ui.viewport.scrollLeft, scrollTop: h.ui.viewport.scrollTop, left: h.ui.pageWrap.style.left, top: h.ui.pageWrap.style.top }, before);
  });
  await check('Queued zoom work cannot rescale a different source page', async () => {
    const h = harness(), canvas = h.ui.canvas; await h.audit.zoomBy(1.5, [200, 150]); h.state.page = 2;
    h.frame(); assert.equal(h.overlays.length, 0); assert.equal([...h.timers.values()].filter(timer => timer.delay === 120).length, 0); assert.equal(h.ui.canvas, canvas);
    const pending = h.audit.renderPage(); await flush(); assert.equal(h.state.viewport, null); h.renders[0].resolve(); await pending;
    assert.equal(h.state.displayKey, JSON.stringify(['session', 'doc', 2, 0])); assert.equal(h.commands[0].page, 2);
  });
  await check('Late failure from an invalidated refinement cannot hide a newer preview or record false evidence', async () => {
    const h = harness(); await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.timer(120); await flush(); const old = h.renders[0];
    await h.audit.zoomBy(1.2, [200, 150]); h.frame(); old.reject(new Error('Stale render failure')); await flush();
    assert.ok(h.state.viewport); assert.equal(h.state.pageError, undefined); assert.equal(h.commands.length, 0);
    h.timer(120); await flush(); await h.finish(); assert.equal(h.commands.length, 1); assert.equal(h.commands[0].success, true);
  });
  await check('A current failed refinement blocks the page and clears all reusable display state', async () => {
    const h = harness(); await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.timer(120); await flush(); h.renders[0].reject(new Error('Incomplete PDF content')); await flush();
    assert.equal(h.state.viewport, null); assert.equal(h.state.displayPage, null); assert.equal(h.state.displayKey, null); assert.equal(h.ui.pageWrap.hidden, true); assert.equal(h.commands.length, 1); assert.equal(h.commands[0].success, false);
  });
  await check('Refinement reuses only the exact successful page proof and still records new PDF warnings', async () => {
    for (const scenario of ['matching', 'wrong-source', 'other-page', 'prior-failed', 'new-warning']) {
      const h = harness(), proof = { document_id: 'doc', page: 1, sha256: 'a'.repeat(64), success: true, warnings: [] };
      if (scenario === 'wrong-source') proof.sha256 = 'b'.repeat(64);
      if (scenario === 'other-page') proof.page = 2;
      if (scenario === 'prior-failed') proof.success = false;
      h.state.session.snapshot.render_checks = [proof];
      await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.timer(120); await flush();
      if (scenario === 'new-warning') h.state.pdfWarnings.set('doc', ['PDF warning: Missing source font']);
      const gesture = h.state.gesture = { kind: 'point', reference: { revision: 0 } };
      await h.finish(); assert.equal(h.state.gesture, gesture); assert.equal(h.state.session.revision, 0);
      assert.equal(h.commands.length, scenario === 'matching' ? 0 : 1, scenario);
      if (scenario === 'new-warning') { assert.equal(h.commands[0].success, false); assert.deepEqual(h.commands[0].warnings, ['PDF warning: Missing source font']); assert.match(h.ui.message.textContent, /Review and confirmation are blocked/); }
    }
  });
  await check('Rotated cropped page previews preserve the cursor source point without changing saved data', async () => {
    const h = harness(); h.page.getViewport = ({ scale }) => ({ width: 200 * scale, height: 300 * scale, transform: [0, scale, scale, 0, -20 * scale, -10 * scale] });
    h.audit.displayViewport(h.page.getViewport({ scale: 1 }), null); const client = [230.125, 190.5], before = copy(h.point(client)), snapshot = copy(h.state.session.snapshot);
    await h.audit.zoomBy(2, client); h.frame(); near(h.point(client)[0], before[0]); near(h.point(client)[1], before[1]); assert.deepEqual(copy(h.state.session.snapshot), snapshot);
    h.timer(120); await flush(); await h.finish(); near(h.point(client)[0], before[0]); near(h.point(client)[1], before[1]);
  });
  await check('Quantized browser scroll offsets preserve fractional page positions and sequential zoom anchors without source writes', async () => {
    const h = harness(), snapshot = copy(h.state.session.snapshot), originalViewport = h.state.viewport;
    for (const name of ['scrollLeft', 'scrollTop']) {
      let value = Math.round(h.ui.viewport[name]);
      Object.defineProperty(h.ui.viewport, name, { get() { return value; }, set(next) { value = Math.max(0, Math.round(next)); } });
    }
    for (const [left, top] of [[24.35, 18.65], [-330.45, -220.55], [600.125, 420.875], [-.123456789, -.987654321]]) {
      h.audit.positionPage(left, top); const paper = h.ui.pageWrap.getBoundingClientRect(), frame = h.ui.viewport.getBoundingClientRect();
      near(paper.left - frame.left - h.ui.viewport.clientLeft, left); near(paper.top - frame.top - h.ui.viewport.clientTop, top);
      assert.equal(h.state.viewport, originalViewport); assert.equal(h.state.zoom, 1);
    }
    const cursor = [223.125, 185.375], source = copy(h.point(cursor));
    for (const factor of [...Array(12).fill(1.03), ...Array(12).fill(1 / 1.03)]) {
      await h.audit.zoomBy(factor, cursor); h.frame(); near(h.point(cursor)[0], source[0]); near(h.point(cursor)[1], source[1]);
    }
    near(h.state.zoom, 1); assert.deepEqual(copy(h.state.session.snapshot), snapshot); assert.equal(h.commands.length, 0); assert.equal(h.renders.length, 0);
    h.audit.cancelQueuedZoom();
  });
  await check('Very wide, tall and large-area PDF bitmaps respect dimension and pixel budgets without changing display coordinates', async () => {
    for (const [width, height] of [[30000, 800], [800, 30000], [20000, 20000]]) {
      const h = harness(); h.context.window.devicePixelRatio = 2;
      h.page.getViewport = ({ scale }) => ({ width: width * scale, height: height * scale, transform: [scale, 0, 0, -scale, 0, height * scale] });
      h.audit.displayViewport(h.page.getViewport({ scale: 1 }), null); const client = [210, 170], point = copy(h.point(client));
      const rendering = h.audit.renderPage(null, { refine: true }); await flush(); await h.finish(); await rendering;
      assert.ok(h.ui.canvas.width <= 16384 && h.ui.canvas.height <= 16384); assert.ok(h.ui.canvas.width * h.ui.canvas.height <= 16000000);
      assert.equal(h.ui.canvas.style.width, `${width}px`); assert.equal(h.ui.canvas.style.height, `${height}px`); assert.equal(h.state.viewport.width, width); assert.equal(h.state.viewport.height, height);
      near(h.point(client)[0], point[0]); near(h.point(client)[1], point[1]);
    }
  });
  await check('Releasing a project cancels queued frames and refinement timers', async () => {
    for (const stage of ['frame', 'timer']) {
      const h = harness(); await h.audit.zoomBy(1.2, [200, 150]); if (stage === 'timer') h.frame(); await h.audit.releaseDocuments();
      assert.equal(h.frames.size, 0); assert.equal([...h.timers.values()].filter(timer => timer.delay === 120).length, 0); assert.equal(h.state.displayPage, null); assert.equal(h.state.displayKey, null);
    }
  });
  await check('An active pan continues when the settled zoom refinement starts', async () => {
    const h = harness(); await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.state.tool = 'pan';
    const event = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
    h.audit.beginPan(event(100, 100)); h.ui.viewport.events.pointermove(event(110, 120)); const before = h.ui.pageWrap.getBoundingClientRect();
    h.timer(120); await flush(); h.ui.viewport.events.pointermove(event(130, 150)); const after = h.ui.pageWrap.getBoundingClientRect();
    near(after.left - before.left, 20); near(after.top - before.top, 30); h.ui.viewport.events.pointerup(event(130, 150)); await h.finish();
  });
  await check('Clockwise rotation composes with original rotation, preserves source points and is scoped per page', async () => {
    const h = harness(), saved = copy(h.state.session.snapshot), requested = [];
    h.page.rotate = 90;
    h.page.getViewport = ({ scale, rotation }) => {
      requested.push(rotation);
      const transforms = [[1, 0, 0, -1, 0, 300], [0, 1, 1, 0, 0, 0], [-1, 0, 0, 1, 200, 0], [0, -1, -1, 0, 300, 200]];
      const swapped = rotation % 180 !== 0;
      return { width: (swapped ? 300 : 200) * scale, height: (swapped ? 200 : 300) * scale, transform: transforms[rotation / 90].map(value => value * scale) };
    };
    for (const expected of [180, 270, 0, 90]) {
      const pending = h.audit.rotatePage(); await flush(); await h.finish(); await pending;
      assert.equal(requested.at(-1), expected);
      const p = geometry.transform([60, 120], h.state.viewport.transform), paper = h.ui.pageWrap.getBoundingClientRect();
      const original = h.point([paper.left + p[0], paper.top + p[1]]);
      near(original[0], 60); near(original[1], 120);
      assert.deepEqual(copy(h.state.session.snapshot), saved, 'Rotation never rewrites retained source coordinates or quantities');
    }
    h.state.page = 2; assert.equal(h.audit.pageRotation(), 0);
    const pending = h.audit.rotatePage(); await flush(); await h.finish(); await pending;
    assert.equal(h.audit.pageRotation(), 90); h.state.page = 1; assert.equal(h.audit.pageRotation(), 0);
    await h.audit.releaseDocuments(); assert.equal(h.state.pageRotations.size, 0);
  });
  await check('Rotation cancels an obsolete zoom refinement and refuses an unfinished trace', async () => {
    const h = harness(); await h.audit.zoomBy(1.5, [200, 150]); h.frame(); h.timer(120); await flush();
    const previous = h.renders[0], canvas = h.ui.canvas;
    const pending = h.audit.rotatePage(); await flush(); assert.equal(previous.cancelled, true);
    await h.finish(previous); assert.equal(h.ui.canvas, canvas);
    await h.finish(h.renders[1]); await pending;
    assert.equal(h.audit.pageRotation(), 90);
    h.state.points = [[10, 20]];
    await assert.rejects(h.audit.rotatePage(), /finish or cancel/i);
    assert.equal(h.audit.pageRotation(), 90);
  });
  console.log(`${passed} smooth zoom checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
