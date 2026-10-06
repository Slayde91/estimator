"use strict";
const assert = require('node:assert/strict'), {test} = require('node:test');
const S = require('../static/takeoff-search.js');
const sha256 = 'a'.repeat(64);
function harness({hold, clock, onMessage} = {}) {
  const workers = [], canvases = [], messages = []; let rendered = 0, cancelled = 0;
  const factory = url => {
    const worker = {url, terminated: 0, recognitions: 0, terminate() {this.terminated++;}, postMessage(message) {
      messages.push(message);
      onMessage?.(message);
      if (message.action === hold) return;
      const data = message.action === 'recognize' && ++this.recognitions % 4 === 1 ? {blocks: [{paragraphs: [{lines: [{words: [
        {text: 'AIR', confidence: 92, bbox: {x0: 10, y0: 20, x1: 35, y1: 35}},
        {text: 'CONDITIONER', confidence: 81, bbox: {x0: 40, y0: 20, x1: 150, y1: 35}},
        {text: 'BEYOND', confidence: 90, bbox: {x0: 40, y0: 43, x1: 100, y1: 58}},
        {text: 'UNSAFE', confidence: 100, bbox: {x0: NaN, y0: 1, x1: 9, y1: 10}},
        {text: 'NOISY', confidence: 12, bbox: {x0: 150, y0: 60, x1: 180, y1: 75}},
      ]}]}]}]} : {blocks: []};
      queueMicrotask(() => worker.onmessage?.({data: {workerId: message.workerId, jobId: message.jobId, status: 'resolve', data}}));
    }}; workers.push(worker); return worker;
  };
  const canvasFactory = () => {
    const context = {fills: [], fillRect(...args) {this.fills.push(args);}, drawImage() {}, setTransform() {}};
    const canvas = {width: 0, height: 0, context, getContext() {return context;}, toBlob(callback) {queueMicrotask(() => callback(new Blob([new Uint8Array([1, 2, 3])])));}};
    canvases.push(canvas); return canvas;
  };
  const page = number => ({pageNumber: number, getViewport({scale}) {return {width: 100 * scale, height: 60 * scale, transform: [scale, 0, 0, -scale, 20 * scale, 200 * scale]};}, render() {rendered++; return {promise: Promise.resolve(), cancel() {cancelled++;}};}});
  const manager = S.createOcrSearch({workerFactory: factory, canvasFactory, baseUrl: 'http://127.0.0.1:12345/', ...(clock ? {clock} : {})});
  return {manager, page, workers, canvases, messages, counts: () => ({rendered, cancelled})};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('OCR maps recognized word rectangles through the original transform, keeps case/line phrase and has no native authority', async () => {
  const h = harness(), source = [{str: 'Native note', transform: [10, 0, 0, 10, 1, 1], width: 30, height: 10}], retained = JSON.stringify(source);
  try {
    const result = await h.manager.recognizePage(h.page(1), {sha256, items: source});
    assert.equal(result.words.length, 3, 'Bad geometry and low-confidence noise are excluded');
    const hits = S.findOcr(result, 'air\nconditioner beyond'); assert.equal(hits.length, 1);
    assert.equal(hits[0].confidence, 81); assert.equal(hits[0].authority, 'search-only'); assert.equal(hits[0].approximate, true);
    assert.equal(hits[0].geometry, 'ocr-word-bounds'); assert.equal(hits[0].source, 'local-ocr');
    assert.equal(hits[0].textParts.filter(part => part.matched).map(part => part.text).join(''), 'AIRCONDITIONERBEYOND');
    assert.deepEqual(hits[0].matchQuads[0], [[-15, 190], [-2.5, 190], [-2.5, 182.5], [-15, 182.5]]);
    assert.equal(JSON.stringify(source), retained); assert.equal(h.canvases[0].context.fills.length, 1, 'Only disposable OCR canvas masks native text');
    assert.ok(h.workers[0].url.startsWith('http://127.0.0.1:12345/vendor/ocr/'));
    const language = h.messages.find(message => message.action === 'loadLanguage').payload.options;
    assert.equal(language.cacheMethod, 'none'); assert.equal(language.langPath, 'http://127.0.0.1:12345/vendor/ocr/lang');
    assert.equal(h.messages.find(message => message.action === 'load').payload.options.corePath, 'http://127.0.0.1:12345/vendor/ocr/core');
    assert.ok(h.canvases.every(canvas => canvas.width === 1 && canvas.height === 1), 'Recognition bitmaps are released');
  } finally {h.manager.dispose();}
});

test('Tile overlap retains highest confidence and unrelated columns cannot create a phrase', () => {
  const words = S.mergeOcrWords([
    {text: 'AIR', confidence: 60, box: [10, 10, 35, 25], quad: [[1, 1]]},
    {text: 'AIR', confidence: 92, box: [11, 10, 36, 25], quad: [[2, 2]]},
    {text: 'AR', confidence: 89, box: [11, 10, 36, 25], quad: [[2, 2]]},
    {text: 'CONDITIONER', confidence: 81, box: [40, 10, 150, 25], quad: [[3, 3]]},
    {text: 'REMOTE', confidence: 90, box: [500, 10, 600, 25], quad: [[4, 4]]},
  ]);
  assert.equal(words.length, 3); assert.equal(words[0].confidence, 92);
  assert.equal(S.findOcr({words}, 'AIR CONDITIONER').length, 1);
  assert.equal(S.findOcr({words}, 'CONDITIONER REMOTE').length, 0);
  assert.equal(S.findOcr({words}, 'AIR', [{contextQuads: [[[0, 0], [10, 0], [10, 10], [0, 10]]]}]).length, 0, 'Native geometry wins over overlapping OCR');
});

test('Rotation, crop translation and UserUnit are inverted without proportional glyph invention', () => {
  for (const transform of [[2, 0, 0, -2, -40, 1140], [0, 4, 4, 0, -120, -80], [-2, 0, 0, 2, 1160, -60], [0, -2, -2, 0, 1140, 1160]]) {
    const original = [[50, 100], [150, 100], [150, 140], [50, 140]];
    const rendered = original.map(([x, y]) => [x * transform[0] + y * transform[2] + transform[4], x * transform[1] + y * transform[3] + transform[5]]);
    const box = [Math.min(...rendered.map(p => p[0])), Math.min(...rendered.map(p => p[1])), Math.max(...rendered.map(p => p[0])), Math.max(...rendered.map(p => p[1]))];
    assert.deepEqual(S.rectangleQuad(box, transform).map(point => point.join(',')).sort(), original.map(point => point.join(',')).sort());
  }
  assert.throws(() => S.rectangleQuad([1, 2, 3, 4], [0, 0, 0, 0, 0, 0]), /valid original PDF/);
});

for (const stage of ['load', 'recognize']) test(`Cancellation terminates real worker ownership during ${stage} and rejects late work`, async () => {
  const h = harness({hold: stage}), controller = new AbortController();
  const pending = h.manager.recognizePage(h.page(1), {sha256, signal: controller.signal}); const rejected = assert.rejects(pending, error => error.name === 'SearchCancelled');
  while (!h.messages.some(message => message.action === stage)) await tick();
  const late = h.workers[0].onmessage, message = h.messages.at(-1); controller.abort(); await rejected;
  assert.equal(h.workers[0].terminated, 1); assert.equal(h.counts().cancelled, 1);
  late({data: {workerId: message.workerId, jobId: message.jobId, status: 'resolve', data: {blocks: []}}});
  assert.ok(h.canvases.every(canvas => canvas.width === 1 && canvas.height === 1)); h.manager.dispose();
});

test('Backpressure is one worker; page budget and malformed retained identity reject before recognition', async () => {
  const h = harness({hold: 'load'}), controller = new AbortController();
  const pending = h.manager.recognizePage(h.page(1), {sha256, signal: controller.signal}); const rejected = assert.rejects(pending, /cancelled/);
  while (!h.messages.length) await tick();
  await assert.rejects(h.manager.recognizePage(h.page(2), {sha256}), error => error.name === 'OcrBusyError');
  controller.abort(); await rejected; assert.equal(h.workers.length, 1);
  await assert.rejects(h.manager.recognizePage(h.page(3), {sha256, budget: {pages: 8, started: Date.now()}}), error => error.name === 'OcrLimitError');
  await assert.rejects(h.manager.recognizePage(h.page(3), {sha256: 'untrusted-path.pdf'}), /fingerprint/); h.manager.dispose();
});

test('Completed OCR cache is source/page/transform specific and bounded; no recognition on repeated query', async () => {
  const h = harness();
  try {
    const first = await h.manager.recognizePage(h.page(1), {sha256});
    const again = await h.manager.recognizePage(h.page(1), {sha256}); assert.equal(first, again); assert.equal(h.counts().rendered, 1);
    assert.equal(S.findOcr(first, 'AIR').length, 1); assert.equal(S.findOcr(first, 'BEYOND').length, 1);
    for (let page = 2; page <= 9; page++) await h.manager.recognizePage(h.page(page), {sha256});
    await h.manager.recognizePage(h.page(1), {sha256}); assert.equal(h.counts().rendered, 10, 'Ninth page evicts oldest cached recognition');
    await h.manager.recognizePage(h.page(1), {sha256: 'b'.repeat(64)}); assert.equal(h.counts().rendered, 11, 'Changed original PDF fingerprint cannot reuse cached recognition');
    assert.equal(h.workers.length, 1, 'Warm sequential work reuses exactly one worker');
  } finally {h.manager.dispose();}
});

test('Deadline expiry destroys the worker and releases bitmaps without waiting for an unbounded engine', async () => {
  let now = Date.now(); const h = harness({clock: () => now});
  const original = h.page(1), render = original.render;
  original.render = (...args) => {now += 60001; return render(...args);};
  await assert.rejects(h.manager.recognizePage(original, {sha256}), error => error.name === 'OcrTimeoutError');
  assert.ok(h.canvases.every(canvas => canvas.width === 1 && canvas.height === 1)); h.manager.dispose();
});

test('Later orientation timeout retains completed tiles with explicit partial coverage, and manager cancellation owns startup', async () => {
  let now = Date.now(), recognitions = 0;
  const h = harness({clock: () => now, onMessage: message => {if (message.action === 'recognize' && ++recognitions === 2) now += 60001;}});
  try {
    const result = await h.manager.recognizePage(h.page(1), {sha256});
    assert.equal(result.partial, true); assert.match(result.partialReasons[0], /time limit.*incomplete/);
    assert.deepEqual(result.completedRotations, [0]); assert.equal(S.findOcr(result, 'AIR CONDITIONER').length, 1);
    assert.equal(h.workers[0].terminated, 1);
  } finally {h.manager.dispose();}
  const loading = harness({hold: 'load'}), pending = loading.manager.recognizePage(loading.page(1), {sha256});
  const rejected = assert.rejects(pending, error => error.name === 'SearchCancelled'); while (!loading.messages.length) await tick();
  loading.manager.cancel(); await rejected; assert.equal(loading.workers[0].terminated, 1); loading.manager.dispose();
});
