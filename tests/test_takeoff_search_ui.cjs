"use strict";
// Exercise production run guards and stream cancellation with a controllably
// slow PDF reader. The real parser/render/coordinates are checked in browser QA.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const S = require('../static/takeoff-search.js');
const G = require('../static/takeoff-geometry.js');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function harness() {
  const element = tag => ({ tag, value: '', dataset: {}, hidden: false, textContent: '', children: [], replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, contains(value) { return !!value && this.children.includes(value); }, addEventListener() {}, setAttribute() {}, classList: { toggle() {} } });
  const context = { window: { CeasefireTakeoffSearch: S, CeasefireTakeoffGeometry: G }, document: { getElementById() {}, createElement: element }, setTimeout, clearTimeout, AbortController, Error, console };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit={state,searchContextKey,searchCurrent,readSearchText,cancelSearch,waitSearch,invalidateSearchContext,runSearch,hideSearchResults,showSearchResults,renderSearchResults,scheduleSearch,productionSelect:selectSearchHit,noRender(){renderOverlay=()=>{};},geometry(fn){updateSearchGeometry=fn;},select(fn){selectSearchHit=fn;},navigate(fn){navigateDocument=fn;},position(fn){positionPage=fn;}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const { audit } = context; audit.noRender();
  Object.assign(audit.state, { session: { session_id: 'session', snapshot: { documents: [{ id: 'doc', sha256: 'hash', pages: [{ page: 1 }, { page: 2 }] }] } }, document: 'doc', searchId: 1,
    ui: { search: element(), searchScope: element(), searchOcr: { ...element(), checked: false }, searchResults: element(), progress: element() } });
  audit.state.ui.search.value = 'wall'; audit.state.ui.searchScope.value = 'document';
  const token = { id: 1, context: audit.searchContextKey(), query: 'wall', session: 'session', document: 'doc', waiters: new Set(), cancelled: false, finished: false, nativeFinished: false, ocrAbort: new AbortController() };
  Object.assign(audit.state, { searchToken: token, searchContext: token.context, searchQuery: token.query, searchHits: [{ id: 'visible' }], searchActiveId: 'visible' });
  return { audit, state: audit.state, token, window: context.window };
}
(async () => {
  const h = harness(); assert.equal(h.audit.searchCurrent(h.token), true);
  for (const [change, restore] of [
    [() => { h.state.ui.search.value = 'new'; }, () => { h.state.ui.search.value = 'wall'; }],
    [() => { h.state.ui.searchScope.value = 'all'; }, () => { h.state.ui.searchScope.value = 'document'; }],
    [() => { h.state.ui.searchOcr.checked = true; }, () => { h.state.ui.searchOcr.checked = false; }],
    [() => { h.state.session.session_id = 'new-project'; }, () => { h.state.session.session_id = 'session'; }],
    [() => { h.state.session.snapshot.documents[0].sha256 = 'changed-source'; }, () => { h.state.session.snapshot.documents[0].sha256 = 'hash'; }],
    [() => { h.state.document = 'other'; }, () => { h.state.document = 'doc'; }],
    [() => { h.state.searchId++; }, () => { h.state.searchId--; }],
  ]) { change(); assert.equal(h.audit.searchCurrent(h.token), false, 'Changed query/scope/session/source/document/run cannot publish results'); restore(); }
  const read = deferred(), cancelAcknowledged = deferred(); let cancelled = 0, reads = 0, released = 0;
  const reader = { read() { reads++; return read.promise; }, cancel(reason) { assert.ok(reason instanceof Error, 'PDF.js cancellation requires an Error reason'); assert.equal(reason.name, 'SearchCancelled'); cancelled++; read.resolve({ done: true }); return cancelAcknowledged.promise; }, releaseLock() { released++; } };
  const extraction = h.audit.readSearchText({ pageNumber: 1, streamTextContent() { return { getReader() { return reader; } }; } }, h.token, { id: 'doc' }, {});
  assert.equal(reads, 1); h.audit.cancelSearch(true, 'Stopped');
  await assert.rejects(extraction, error => error.name === 'SearchCancelled');
  assert.equal(cancelled, 1, 'Stop and extraction cleanup share one PDF stream cancellation'); assert.equal(reads, 1, 'Cancellation starts no further extraction');
  assert.equal(released, 0, 'The reader stays owned until worker cancellation is acknowledged');
  cancelAcknowledged.resolve(); for (let i = 0; i < 4; i++) await Promise.resolve(); assert.equal(released, 1, 'Cancellation releases its stream reader exactly once');
  assert.equal(h.state.ui.search.value, ''); assert.equal(h.state.searchHits.length, 0); assert.equal(h.state.searchActiveId, null); assert.equal(h.state.ui.searchResults.hidden, true);
  assert.equal(h.token.ocrAbort.signal.aborted, true, 'Stop also cancels local engine work, including initialization');
  assert.equal(h.audit.searchCurrent(h.token), false, 'Late read completion remains unable to publish');
  const complete = harness(); let completeReads = 0, completeCancelled = 0, completeReleased = 0;
  const completeReader = { read() { return Promise.resolve(++completeReads === 1 ? { done: false, value: { items: [{ str: 'native wall' }] } } : { done: true }); }, cancel() { completeCancelled++; return Promise.resolve(); }, releaseLock() { completeReleased++; } };
  const completeText = await complete.audit.readSearchText({ pageNumber: 1, streamTextContent() { return { getReader() { return completeReader; } }; } }, complete.token, { id: 'doc' }, {});
  assert.equal(completeText.items[0].str, 'native wall'); assert.equal(completeReads, 2); assert.equal(completeCancelled, 0, 'A fully drained PDF stream is not cancelled after EOF'); assert.equal(completeReleased, 1, 'Completed extraction releases its reader');
  assert.equal(complete.token.reader, null); assert.equal(complete.token.cancelReader, null, 'Completed extraction cannot be cancelled again by a later Stop'); complete.audit.cancelSearch(true);
  const all = harness(); all.state.ui.searchScope.value = 'all'; all.token.context = all.audit.searchContextKey(); all.state.searchContext = all.token.context; all.state.document = 'another-document';
  assert.equal(all.audit.searchCurrent(all.token), false, 'Changing current document during all-document extraction cancels stale publication');
  all.token.finished = true; assert.equal(all.audit.searchCurrent(all.token), true, 'Completed all-document results allow explicit dropdown navigation');
  const pageChange = harness(); pageChange.state.searchActivePage = 'doc:1'; pageChange.state.page = 2; pageChange.audit.invalidateSearchContext();
  assert.equal(pageChange.state.searchActiveId, null, 'Changing page resets the cycle so the next Search chooses its nearest hit');
  const dismissed = harness();
  dismissed.state.searchHits = [{ id: 'source-match', document_name: 'Original.pdf', page: 1, text: 'A <wall> remains.', textParts: [{ text: 'A ', matched: false }, { text: '<wall>', matched: true }, { text: ' remains.', matched: false }] }];
  dismissed.audit.renderSearchResults(); assert.equal(dismissed.state.ui.searchResults.hidden, false);
  const query = dismissed.state.ui.search.value, runId = dismissed.state.searchId;
  dismissed.audit.hideSearchResults(); dismissed.audit.renderSearchResults();
  assert.equal(dismissed.state.ui.searchResults.hidden, true, 'A late asynchronous result update cannot reopen dismissed results');
  assert.equal(dismissed.state.ui.search.value, query); assert.equal(dismissed.state.searchId, runId); assert.equal(dismissed.state.searchHits.length, 1, 'Dismissal preserves the search and highlights');
  const marked = dismissed.state.ui.searchResults.children[0].children.filter(child => child.tag === 'mark');
  assert.equal(marked.length, 1); assert.equal(marked[0].textContent, '<wall>', 'Matched text is rendered as text, never as HTML');
  dismissed.audit.showSearchResults(); assert.equal(dismissed.state.ui.searchResults.hidden, false, 'An explicit input/Search action reopens current results');
  dismissed.audit.hideSearchResults(); dismissed.audit.scheduleSearch(); assert.equal(dismissed.state.searchDismissed, false, 'Typing a new query releases dismissal'); dismissed.audit.cancelSearch(true);
  const lateLayout = harness(), layout = deferred(), selected = [], box = { left: 0, top: 0, width: 100, height: 100 };
  lateLayout.token.nativeFinished = true;
  lateLayout.audit.geometry(() => layout.promise); lateLayout.audit.select(hit => selected.push(hit.id));
  Object.assign(lateLayout.state, { searchComplete: true, searchNativePromise: Promise.resolve(), searchPromise: Promise.resolve(), viewport: { transform: [1, 0, 0, 1, 0, 0] },
    searchHits: [{ id: 'old', document_id: 'doc', page: 1, points: [[10, 10]] }] });
  Object.assign(lateLayout.state.ui, { pageWrap: { getBoundingClientRect: () => box }, viewport: { getBoundingClientRect: () => box } });
  const oldActivation = lateLayout.audit.runSearch(); for (let i = 0; i < 10; i++) await Promise.resolve();
  lateLayout.audit.cancelSearch(false); lateLayout.state.ui.search.value = 'cable'; lateLayout.state.searchQuery = 'cable';
  lateLayout.state.searchContext = lateLayout.audit.searchContextKey(); lateLayout.state.searchComplete = true;
  lateLayout.state.searchToken = { ...lateLayout.token, id: lateLayout.state.searchId, query: 'cable', context: lateLayout.state.searchContext, cancelled: false, nativeFinished: true };
  lateLayout.state.searchNativePromise = Promise.resolve(); lateLayout.state.searchPromise = Promise.resolve(); lateLayout.state.searchHits = [{ id: 'new-query-hit', document_id: 'doc', page: 1, points: [[25, 25]] }];
  layout.resolve(); await oldActivation;
  assert.deepEqual(selected, [], 'An old Search press waiting for native text layout cannot activate a newly typed query');
  await lateLayout.audit.runSearch(); assert.deepEqual(selected, ['new-query-hit'], 'A fresh Search press still chooses the current query result');
  const nativeFirst = harness(), nativeReady = deferred(), ocrPending = deferred(), activated = [];
  nativeFirst.audit.geometry(() => Promise.resolve()); nativeFirst.audit.select(hit => activated.push(hit.id));
  Object.assign(nativeFirst.state, { searchComplete: false, searchNativePromise: nativeReady.promise, searchPromise: ocrPending.promise, viewport: { transform: [1, 0, 0, 1, 0, 0] },
    searchHits: [{ id: 'native-ready', document_id: 'doc', page: 1, points: [[10, 10]] }] });
  Object.assign(nativeFirst.state.ui, { pageWrap: { getBoundingClientRect: () => box }, viewport: { getBoundingClientRect: () => box } });
  const nativeActivation = nativeFirst.audit.runSearch(); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(activated, [], 'Search waits for native extraction readiness before choosing a hit');
  nativeFirst.token.nativeFinished = true; nativeReady.resolve(); await nativeActivation;
  assert.deepEqual(activated, ['native-ready'], 'Native results remain usable while local OCR is still pending');
  assert.equal(nativeFirst.state.searchComplete, false, 'Early native activation does not claim OCR completion');
  nativeFirst.audit.cancelSearch(true); ocrPending.resolve();
  for (const keepReading of [true, false]) {
    const progressive = harness(), navigation = deferred();
    const reading = {id: 'early-label', source: 'local-ocr', document_id: 'doc', document_name: 'Drawing.pdf', page: 1, confidence: 70, points: [[10, 10]], matchQuads: [[[0, 0], [100, 0], [100, 10], [0, 10]]]};
    Object.assign(progressive.state, {document: 'another-document', page: 1, searchHits: [reading], searchActiveId: null, viewport: {transform: [1, 0, 0, 1, 0, 0]}});
    progressive.state.ui.viewport = {clientWidth: 100, clientHeight: 100}; progressive.audit.position(() => {}); progressive.audit.geometry(() => Promise.resolve());
    progressive.audit.navigate(() => navigation.promise); const activation = progressive.audit.productionSelect(reading, true);
    progressive.state.searchHits = keepReading ? S.reconcileOcrHits([reading], [{...reading, id: 'refined-label', confidence: 92, matchQuads: [[[1, 0], [101, 0], [101, 10], [1, 10]]]}]) : [];
    progressive.state.document = 'doc'; navigation.resolve(true); await activation;
    if (keepReading) {
      assert.equal(progressive.state.searchHits[0], reading); assert.equal(progressive.state.searchActiveId, 'early-label');
      assert.match(progressive.state.ui.progress.textContent, /Current-page match 1\./, 'Awaited navigation uses the retained object after later recognition refines it');
    } else {
      assert.equal(progressive.state.searchActiveId, null); assert.doesNotMatch(progressive.state.ui.progress.textContent, /Current-page match/, 'A removed provisional reading cannot be reactivated by a late navigation');
    }
  }
  for (const target of ['another-document', 'another-page']) {
    const moved = harness(), geometry = deferred(), positions = [];
    const reading = {id: 'old-page-label', source: 'local-ocr', document_id: 'doc', document_name: 'Drawing.pdf', page: 1, confidence: 90, points: [[10, 10]], matchQuads: [[[0, 0], [100, 0], [100, 10], [0, 10]]]};
    Object.assign(moved.state, {page: 1, searchHits: [reading], viewport: {transform: [1, 0, 0, 1, 0, 0]}});
    moved.state.ui.viewport = {clientWidth: 100, clientHeight: 100}; moved.audit.position((...args) => positions.push(args)); moved.audit.geometry(() => geometry.promise);
    const activation = moved.audit.productionSelect(reading);
    if (target === 'another-document') moved.state.document = 'other'; else moved.state.page = 2;
    geometry.resolve(); await activation;
    assert.deepEqual(positions, [], 'An all-document search result waiting for text layout cannot reposition a different page');
    assert.doesNotMatch(moved.state.ui.progress.textContent, /Current-page match/);
  }
  const overlong = harness(); let overlongWorkers = 0;
  overlong.window.CeasefireTakeoffSearch = { ...S, createOcrSearch() { overlongWorkers++; throw new Error('Invalid queries must not start local OCR'); } };
  overlong.state.ui.searchOcr.checked = true; overlong.state.ui.search.value = 'x'.repeat(S.MAX_QUERY + 1);
  await assert.rejects(overlong.audit.runSearch(), /Search is limited to 200 characters/, 'A direct overlong Search rejects through the caller instead of leaving an unhandled startup promise');
  assert.equal(overlongWorkers, 0); assert.equal(overlong.state.searchNativePromise, null); assert.equal(overlong.state.searchToken, null); assert.equal(overlong.state.searchHits.length, 0, 'Invalid startup clears old results before reporting its bounded query error');
  console.log('PASS search query/scope/session/source/document/generation guards, Stop cancellation of active PDF text stream, clear state and late-reader rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
