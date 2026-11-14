const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const elements = [], events = {}, microtasks = [];
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.attrs = {}; this.children = []; this.hidden = false; this.isConnected = true; this.listeners = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = value; for (const child of this.children) child.parentNode = null; this.children = []; }
  append(child) { child.parentNode = this; this.children.push(child); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  matches(selector) { return selector === '.message' && String(this.className).split(/\s+/).includes('message'); }
  closest(selector) { return selector === '[role="tab"]' && this.attrs.role === 'tab' ? this : null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const document = { body: new Element('body'), hidden: false,
  querySelectorAll: selector => elements.filter(element => selector.includes('.message') && (element.matches('.message') || element.className === 'notice' || element.getAttribute('data-notification')==='true')),
  createElement: tag => new Element(tag), addEventListener: (name, callback) => { events[name] = callback; } };
let observer;
const window = { MutationObserver: class { constructor(callback) { observer = callback; } observe() {} } };
const sounds = [];
window.Audio = class {
  readyState = 4;
  load() {}
  pause() {}
  play() { sounds.push(this.src); return Promise.resolve(); }
};
const context = { window, document, MutationObserver: window.MutationObserver, queueMicrotask: callback => microtasks.push(callback), Map };
vm.createContext(context); vm.runInContext(fs.readFileSync('static/notifications.js', 'utf8'), context);
const api = window.CeasefireNotifications;
const notice = text => { const element = new Element(); element.className = 'message'; element.textContent = text; elements.push(element); return element; };
const first = notice('Saved successfully'); api.show(first);
assert.equal(first.hidden, false); assert.equal(first.children.length, 1);
assert.equal(first.textContent, 'Saved successfully', 'The decorative close glyph does not become notification text or status data');
assert.equal(first.children[0].type, 'button'); assert.equal(first.children[0].getAttribute('aria-label'), 'Close');
observer(); observer(); assert.equal(first.children.length, 1, 'Observer does not duplicate dismiss controls');
assert.deepEqual(sounds, [], 'Showing and decorating a status never plays a sound');
assert.equal(first.hidden, false, 'No elapsed-time timer retires notices');
first.children[0].listeners.click(); assert.equal(first.hidden, true, 'Dismiss works with an ordinary native button');
api.navigate('estimate'); api.show(first); api.navigate('pricing'); assert.equal(first.hidden, true);
api.navigate('estimate'); assert.equal(first.hidden, true, 'Returning does not restore a stale notice');
first.textContent = 'The current input is invalid'; api.show(first); assert.equal(first.hidden, false, 'A fresh condition may explain why a notice is needed');
const protectedNotice = notice('Retry linked change'); api.show(protectedNotice, { persistent: true });
api.navigate('takeoffs'); assert.equal(first.hidden, true); assert.equal(protectedNotice.hidden, false, 'Pending recovery retains its required action');
protectedNotice.children[0].listeners.click(); assert.equal(protectedNotice.hidden, true, 'Persistent conditions may still be dismissed manually');
const tab = new Element('button'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false');
first.textContent = 'Old tab notice'; api.show(first); events.click({ target: tab });
tab.setAttribute('aria-selected', 'true'); first.textContent = 'New tab validation'; api.show(first); microtasks.shift()();
assert.equal(first.hidden, false, 'A notice raised by the new tab is not erased by the old tab departure');
tab.setAttribute('aria-selected', 'false'); events.click({ target: tab }); microtasks.shift()(); assert.equal(first.hidden, false, 'A refused tab transition leaves the notice visible');
events.click({ target: tab }); tab.setAttribute('aria-selected', 'true'); microtasks.shift()(); assert.equal(first.hidden, true);
const progress = new Element(); progress.className = 'document-download-progress'; elements.push(progress); observer();
assert.equal(progress.children.length, 0, 'Measured download progress remains outside notice dismissal');
api.show(first); document.hidden = true; events.visibilitychange(); assert.equal(first.hidden, true, 'Leaving the browser tab clears old transient notices');
first.textContent = 'Translated notification'; first.hidden = false; observer(); assert.equal(first.children.length, 1, 'Translation refresh restores the close button without changing message content');
const helper = new Element('p'); helper.className = 'helper certification-save-status'; helper.textContent = 'Revision saved';
elements.push(helper); api.show(helper); assert.equal(helper.children.length, 1);
helper.textContent = 'Revision saved to the selected folder'; observer();
assert.equal(helper.children.length, 1, 'A tracked helper-status refresh restores its dismiss control without requiring the message class');
helper.children[0].listeners.click(); assert.equal(helper.hidden, true);
helper.textContent = 'Translated revision saved'; observer();
assert.equal(helper.hidden, true, 'Refreshing a dismissed helper-status does not show it again');
assert.equal(helper.children.length, 0, 'A dismissed helper receives no hidden interactive control');
console.log('Notification persistence, navigation, dismissal, recovery and progress checks passed.');
// Reveal fresh errors below sticky chrome without refocusing the user's field.
const scrolls = [], frames = [];
let errorTop = 950, allowScroll = true, hit;
document.hidden = false;
window.innerHeight = 800; window.innerWidth = 1000;
window.scrollBy = options => { scrolls.push(options.top); if (allowScroll) errorTop -= options.top; };
window.requestAnimationFrame = callback => frames.push(callback);
const finishFrames = () => { while (frames.length) frames.shift()(); };
document.querySelector = selector => selector === '.app-header' ? { getBoundingClientRect: () => ({bottom: 100}) } : null;
document.elementFromPoint = () => hit;
function position(element) {
  hit = element;
  element.getClientRects = () => element.hidden ? [] : [{}];
  element.getBoundingClientRect = () => ({top: errorTop, bottom: errorTop + 40, left: 10, right: 950});
  element.contains = node => node === element;
}
const error = notice('Invalid current item'); error.className = 'message error'; error.setAttribute('role', 'alert');
position(error);
api.show(error); assert.deepEqual(scrolls, [838]); assert.deepEqual(sounds, ['/sounds/radiobleep.mp3']);
observer(); assert.equal(scrolls.length, 1, 'Decorating the close control does not repeat the error scroll');
errorTop = 50; finishFrames();
assert.deepEqual(scrolls, [838, -62], 'The delayed reveal corrects native focus scrolling');
assert.equal(sounds.length, 1, 'A second scroll for the same error stays silent');
errorTop = 200; api.show(error); finishFrames();
assert.equal(scrolls.length, 2); assert.equal(sounds.length, 1, 'An error already in view stays silent');
errorTop = 200; api.show(error); errorTop = 950; finishFrames();
assert.equal(sounds.length, 2, 'The deferred correction sounds when it is the first actual snap');
errorTop = 950; allowScroll = false; api.show(error); finishFrames();
assert.equal(sounds.length, 2, 'A clamped scroll does not count');
allowScroll = true; hit = null; api.show(error); finishFrames();
assert.equal(sounds.length, 2, 'A notice behind an overlay stays silent despite page movement');
hit = error; errorTop = 950; error.checkVisibility = () => false; api.show(error); finishFrames();
assert.equal(sounds.length, 2, 'An invisible notice stays silent despite page movement');
error.checkVisibility = () => true; document.hidden = true; errorTop = 950; api.show(error); finishFrames();
document.hidden = false;
window.CeasefireAudioSettings = {isEnabled: () => false}; errorTop = 950; api.show(error); finishFrames();
window.CeasefireAudioSettings = {isEnabled: () => true};
assert.equal(sounds.length, 2, 'Background and muted snaps stay silent');
error.textContent = 'Saved'; error.className = 'helper'; error.setAttribute('role', 'status'); errorTop = 950;
const beforeSuccess = scrolls.length; api.show(error); finishFrames();
assert.equal(scrolls.length, beforeSuccess); assert.equal(sounds.length, 2, 'Status messages stay in place silently');
error.textContent = 'New error'; error.className = 'message error'; api.show(error); const count = scrolls.length;
error.children[0].listeners.click(); errorTop = 950; finishFrames();
assert.equal(scrolls.length, count, 'Dismissing an error cancels its pending reveal');
const external = notice('Error created outside the notification API'); external.className = 'message error'; position(external);
observer(); finishFrames();
assert.equal(scrolls.length, count + 1); assert.equal(sounds.length, 4, 'A newly discovered offscreen error sounds when actually revealed');

const passive = notice('Contact saved'); passive.className = 'notice';
observer(); passive.textContent = 'Contact archived'; observer();
passive.hidden = true; observer(); passive.hidden = false; observer();
assert.equal(sounds.length, 4, 'Adding, updating and reopening passive notices stays silent');
assert.equal(passive.children.length, 0, 'Inline notices retain their original controls');
position(passive); passive.scrollIntoView = () => { errorTop = 300; }; errorTop = 950;
api.scrollIntoView(passive, 'center');
assert.equal(errorTop, 950, 'An ordinary inline status is not a target for an error snap');
passive.setAttribute('role', 'alert');
api.scrollIntoView(passive, 'center'); api.scrollIntoView(passive, 'center');
assert.equal(sounds.length, 5, 'Inline alerts play only when their own scroll moves the notice');
position(external); external.scrollIntoView = () => { errorTop = 320; }; errorTop = 950;
external.textContent = 'Dialog error'; api.scrollIntoView(external, 'nearest');
errorTop = 950; observer(); finishFrames();
assert.equal(errorTop, 950); assert.equal(sounds.length, 6, 'The observer leaves a dialog-owned reveal alone');
document.querySelectorAll = () => { throw Error('Document-wide notification rescan'); };
observer([{type:'characterData',target:new Element('span'),addedNodes:[]}]);
assert.equal(sounds.length, 6, 'Unrelated mutations never produce playback');
console.log('Notification snap, sticky header clearance, Tab corrections, mute and passive status checks passed.');
