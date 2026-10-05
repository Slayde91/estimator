"use strict";
// Exercise production run guards and stream cancellation with a controllably
// slow PDF reader. The real parser/render/coordinates are checked in browser QA.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const S = require('../static/takeoff-search.js');
const G = require('../static/takeoff-geometry.js');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function harness() {
  const element = tag => ({ tag, value: '', dataset: {}, hidden: false, textContent: '', children: [], replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, contains(value) { return !!value && this.children.includes(value); }, addEventListener() {}, setAttribute() {}, classList: { toggle() {} } });
  const context = { window: { CeasefireTakeoffSearch: S, CeasefireTakeoffGeometry: G }, document: { getElementById() {}, createElement: element }, setTimeout, clearTimeout, console };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit={state,searchContextKey,searchCurrent,readSearchText,cancelSearch,waitSearch,invalidateSearchContext,runSearch,hideSearchResults,showSearchResults,renderSearchResults,scheduleSearch,noRender(){renderOverlay=()=>{};},geometry(fn){updateSearchGeometry=fn;},select(fn){selectSearchHit=fn;}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const { audit } = context; audit.noRender();
  Object.assign(audit.state, { session: { session_id: 'session', snapshot: { documents: [{ id: 'doc', sha256: 'hash', pages: [{ page: 1 }, { page: 2 }] }] } }, document: 'doc', searchId: 1,
    ui: { search: element(), searchScope: element(), searchResults: element(), progress: element() } });
  audit.state.ui.search.value = 'wall'; audit.state.ui.searchScope.value = 'document';
  const token = { id: 1, context: audit.searchContextKey(), query: 'wall', session: 'session', document: 'doc', waiters: new Set(), cancelled: false, finished: false };
  Object.assign(audit.state, { searchToken: token, searchContext: token.context, searchQuery: token.query, searchHits: [{ id: 'visible' }], searchActiveId: 'visible' });
  return { audit, state: audit.state, token };
}
(async () => {
  const h = harness(); assert.equal(h.audit.searchCurrent(h.token), true);
  for (const [change, restore] of [
    [() => { h.state.ui.search.value = 'new'; }, () => { h.state.ui.search.value = 'wall'; }],
    [() => { h.state.ui.searchScope.value = 'all'; }, () => { h.state.ui.searchScope.value = 'document'; }],
    [() => { h.state.session.session_id = 'new-project'; }, () => { h.state.session.session_id = 'session'; }],
    [() => { h.state.session.snapshot.documents[0].sha256 = 'changed-source'; }, () => { h.state.session.snapshot.documents[0].sha256 = 'hash'; }],
    [() => { h.state.document = 'other'; }, () => { h.state.document = 'doc'; }],
    [() => { h.state.searchId++; }, () => { h.state.searchId--; }],
  ]) { change(); assert.equal(h.audit.searchCurrent(h.token), false, 'Changed query/scope/session/source/document/run cannot publish results'); restore(); }
  const read = deferred(); let cancelled = 0, reads = 0;
  const reader = { read() { reads++; return read.promise; }, cancel() { cancelled++; read.resolve({ done: true }); return Promise.resolve(); } };
  const extraction = h.audit.readSearchText({ pageNumber: 1, streamTextContent() { return { getReader() { return reader; } }; } }, h.token, { id: 'doc' }, {});
  assert.equal(reads, 1); h.audit.cancelSearch(true, 'Stopped');
  await assert.rejects(extraction, error => error.name === 'SearchCancelled');
  assert.ok(cancelled >= 1, 'Stop cancels the active PDF text stream'); assert.equal(reads, 1, 'Cancellation starts no further extraction');
  assert.equal(h.state.ui.search.value, ''); assert.equal(h.state.searchHits.length, 0); assert.equal(h.state.searchActiveId, null); assert.equal(h.state.ui.searchResults.hidden, true);
  assert.equal(h.audit.searchCurrent(h.token), false, 'Late read completion remains unable to publish');
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
  lateLayout.audit.geometry(() => layout.promise); lateLayout.audit.select(hit => selected.push(hit.id));
  Object.assign(lateLayout.state, { searchComplete: true, searchPromise: Promise.resolve(), viewport: { transform: [1, 0, 0, 1, 0, 0] },
    searchHits: [{ id: 'old', document_id: 'doc', page: 1, points: [[10, 10]] }] });
  Object.assign(lateLayout.state.ui, { pageWrap: { getBoundingClientRect: () => box }, viewport: { getBoundingClientRect: () => box } });
  const oldActivation = lateLayout.audit.runSearch(); for (let i = 0; i < 10; i++) await Promise.resolve();
  lateLayout.audit.cancelSearch(false); lateLayout.state.ui.search.value = 'cable'; lateLayout.state.searchQuery = 'cable';
  lateLayout.state.searchContext = lateLayout.audit.searchContextKey(); lateLayout.state.searchComplete = true;
  lateLayout.state.searchPromise = Promise.resolve(); lateLayout.state.searchHits = [{ id: 'new-query-hit', document_id: 'doc', page: 1, points: [[25, 25]] }];
  layout.resolve(); await oldActivation;
  assert.deepEqual(selected, [], 'An old Search press waiting for native text layout cannot activate a newly typed query');
  await lateLayout.audit.runSearch(); assert.deepEqual(selected, ['new-query-hit'], 'A fresh Search press still chooses the current query result');
  console.log('PASS search query/scope/session/source/document/generation guards, Stop cancellation of active PDF text stream, clear state and late-reader rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
