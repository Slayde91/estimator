"use strict";
// Check source selection and draft protection against production upload(), with
// isolated upload replies; real bytes/parser/renderer are exercised in browser QA.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const copy = value => JSON.parse(JSON.stringify(value));
function harness() {
  const calls = [], fitted = [], context = { window: {}, document: {}, console, Set };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `
  globalThis.audit = {state, upload, configure() {
    ensureSession = async () => state.session; flushSettings = async () => {};
    working = value => { state.busy = value; }; renderData = () => {}; message = () => {}; setProgress = () => {};
    api = async (url, body) => {
      globalThis.calls.push({url, body});
      if (url.endsWith('/uploads')) return {upload_id: 'upload-' + body.filename};
      const next = clone(state.session); next.revision++; next.snapshot.documents.push({id: 'document-' + globalThis.calls.at(-2).body.filename, pages: [{page: 1}]}); return next;
    };
    accept = reply => { state.session = reply; };
    fitPage = async () => globalThis.fitted.push({document: state.document, page: state.page});
  }};
  window.CeasefireTakeoffs = {`);
  Object.assign(context, { calls, fitted, fetch: async () => ({ ok: true }) }); vm.runInContext(source, context);
  const { audit } = context; audit.configure();
  Object.assign(audit.state, { document: 'old', page: 7, calibration: 'old-scale', session: {session_id: 'qa', revision: 1, snapshot: {documents: [{id: 'old', pages: [{page: 1}]}], items: [{id: 'preserved'}], calibrations: [{id: 'preserved-scale', precision: 1.123456789012}], transfers: [{id: 'existing'}]}} });
  return { ...audit, calls, fitted };
}
const file = name => ({name, size: 20, slice() { return 'original bytes'; }});
(async () => {
  const h = harness(), protectedState = copy(h.state.session.snapshot);
  await h.upload([file('new.pdf')]); assert.equal(h.state.document, 'document-new.pdf'); assert.equal(h.state.page, 1); assert.equal(h.state.calibration, '');
  assert.deepEqual(copy(h.fitted), [{document: 'document-new.pdf', page: 1}]);
  for (const key of ['items', 'calibrations', 'transfers']) assert.deepEqual(copy(h.state.session.snapshot[key]), protectedState[key]);
  const batch = harness(); await batch.upload([file('first.pdf'), file('second.pdf')]); assert.equal(batch.state.document, 'document-first.pdf', 'Batch deterministically selects its first successfully imported source'); assert.equal(batch.state.session.snapshot.documents.length, 3);
  const partial = harness(); await assert.rejects(partial.upload([file('first.pdf'), file('invalid.txt')]), /1 PDF\(s\) imported/); assert.equal(partial.state.document, 'document-first.pdf');
  const invalid = harness(); await assert.rejects(invalid.upload([file('invalid.txt')]), /choose a PDF/); assert.equal(invalid.state.document, 'old');
  for (const field of ['formDirty', 'settingsDirty', 'gesture', 'pendingViewport', 'physicalPlacing']) {
    const unfinished = harness(); unfinished.state[field] = true;
    await assert.rejects(unfinished.upload([file('new.pdf')]), /unfinished|physical edits/); assert.equal(unfinished.calls.length, 0); assert.equal(unfinished.state.document, 'old'); assert.equal(unfinished.state[field], true, 'Unfinished drafts remain intact');
  }
  const trace = harness(); trace.state.points = [[10.123456789, 22.987654321]];
  await assert.rejects(trace.upload([file('new.pdf')]), /unfinished/); assert.deepEqual(copy(trace.state.points), [[10.123456789, 22.987654321]]); assert.equal(trace.calls.length, 0);
  console.log('PASS new PDF selection, first-source batch selection, partial failure and preserved protected data/unfinished drafts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
