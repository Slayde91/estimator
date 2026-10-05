// Protect discarded drafts and late edits across queued annotation updates.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  const calls = [], content = { version: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'first' }] }] };
  const context = { console, setTimeout, clearTimeout, window: { CeasefireTakeoffAnnotations: { layout() {} }, CeasefireProject: { changed() {} } }, document: { getElementById() {} } };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit = {state, applyAnnotationSettings, annotationSelectionKey, command(fn){command=fn;}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context); const { state } = context.audit;
  state.mode = 'steel'; state.document = 'd'; state.page = 1; state.annotationSelected = 'a'; state.queue = Promise.resolve();
  state.session = { session_id: 'session', revision: 1, snapshot: { annotations: { version: 1, callouts: [{ id: 'a', mode: 'steel', document_id: 'd', page: 1, width: 238, height: 120, content, appearance: {} }] } } };
  const editor = { kind: 'annotation', id: 'a', sessionId: 'session', key: context.audit.annotationSelectionKey(), touched: new Map([['content', 1]]), rich: { read: () => JSON.parse(JSON.stringify(content)) }, appearance: [] };
  state.settingsEditor = editor; state.settingsDirty = true;
  context.audit.command(async (op, body, guard) => { assert.equal(op, 'update_annotation'); if (!guard()) return null; calls.push(body); return { revision: ++state.session.revision }; });
  return { ...context.audit, editor, calls, content };
}
(async () => {
  const h = harness(), queue = deferred(); h.state.queue = queue.promise;
  const pending = h.applyAnnotationSettings(h.editor); await flush(); h.state.settingsEditor = null; queue.resolve();
  await assert.rejects(pending, /Call-out changed/); assert.equal(h.calls.length, 0, 'Discarded draft never reaches the command queue');
  console.log('ok - A discarded queued Item Details draft cannot write later');
  const late = harness(), first = deferred(); let count = 0;
  late.command(async (op, body, guard) => { assert.equal(guard(), true); late.calls.push(body); if (++count === 1) await first.promise; return { revision: ++late.state.session.revision }; });
  const updating = late.applyAnnotationSettings(late.editor); await flush();
  late.content.blocks[0].runs[0].text = 'newer text'; late.editor.touched.set('content', 2); first.resolve(); await updating;
  assert.deepEqual(late.calls.map(value => value.changes.content.blocks[0].runs[0].text), ['first', 'newer text']); assert.equal(late.state.settingsDirty, false);
  console.log('ok - Text edited during an annotation request is captured in the next update');
})().catch(error => { console.error(error); process.exitCode = 1; });
