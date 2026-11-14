const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const elements = [], events = {}, microtasks = [];
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.attrs = {}; this.children = []; this.hidden = false; this.isConnected = true; this.listeners = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = value; for (const child of this.children) child.parentNode = null; this.children = []; }
  append(child) { child.parentNode = this; this.children.push(child); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs,name); }
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
const scrolls = [], frames = [];
let errorTop, hit;
document.hidden = false;
window.innerHeight = 800; window.innerWidth = 1000;
window.scrollBy = ({top}) => { scrolls.push(top); errorTop -= top; };
window.requestAnimationFrame = callback => frames.push(callback);
const finishFrames = () => { while (frames.length) frames.shift()(); };
document.querySelector = selector => selector === '.app-header' ? {getBoundingClientRect: () => ({bottom: 100})} : null;
document.elementFromPoint = () => hit;
function position(element, top) {
  errorTop = top; hit = element;
  element.getClientRects = () => element.hidden ? [] : [{}];
  element.getBoundingClientRect = () => ({top: errorTop, bottom: errorTop + 40, left: 10, right: 950});
  element.contains = node => node === element;
}
const error = notice('Invalid current item'); error.className = 'message error'; error.setAttribute('role', 'alert');
position(error, 950); api.show(error);
assert.deepEqual(scrolls, [838]); assert.deepEqual(sounds, ['/sounds/radiobleep.mp3']);
observer(); errorTop = 50; finishFrames();
assert.deepEqual(scrolls, [838, -62], 'The deferred reveal corrects native focus scrolling');
assert.equal(sounds.length, 1, 'A second scroll for the same error stays silent');
position(error, 200); error.textContent = 'New validation'; api.show(error); finishFrames();
assert.equal(scrolls.length, 2); assert.equal(sounds.length, 2, 'A fresh visible error announces without a snap');
api.show(error); observer(); finishFrames();
assert.equal(sounds.length, 2, 'Repeated show and redraws of the current notice stay silent');
error.children[0].listeners.click(); api.show(error); finishFrames();
assert.equal(sounds.length, 3, 'A dismissed notice presented again is a new occurrence');

error.textContent = 'Project saved'; error.className = 'message'; error.setAttribute('role','status');
api.show(error); observer(); finishFrames();
assert.equal(scrolls.length, 2); assert.equal(sounds.length, 4, 'A fresh visible success banner plays once without scrolling');
errorTop = 950; error.textContent = 'Saved to a file'; api.show(error); observer(); finishFrames();
assert.equal(scrolls.length, 2); assert.equal(sounds.length, 4, 'Offscreen success feedback stays silent and never scrolls');
errorTop = 200; api.show(error); observer(); assert.equal(sounds.length, 4, 'Showing old text after scrolling does not announce again');
error.className = 'helper'; error.textContent = 'Loading'; api.show(error); observer();
assert.equal(sounds.length, 4, 'Tracked passive helpers stay silent, even in view');

error.className = 'message error'; errorTop = 950; hit = null; error.textContent = 'Covered error'; api.show(error); finishFrames();
assert.equal(sounds.length, 4, 'An error behind an overlay stays silent even if the page moves');
position(error, 170); error.textContent = 'Hidden by CSS'; error.checkVisibility = () => false;
api.show(error); finishFrames(); error.checkVisibility = () => true; observer(); finishFrames();
assert.equal(sounds.length, 4, 'A hidden element does not queue audio for later');
document.hidden = true; error.textContent = 'Background error'; api.show(error); finishFrames(); document.hidden = false;
window.CeasefireAudioSettings = {isEnabled: () => false}; error.textContent = 'Muted error'; api.show(error); finishFrames();
window.CeasefireAudioSettings = {isEnabled: () => true};
assert.equal(sounds.length, 4, 'Background and muted errors stay silent');
error.textContent='Dismiss me'; api.show(error); const count=scrolls.length;
error.children[0].listeners.click(); errorTop=950; finishFrames();
assert.equal(scrolls.length,count,'Dismissing an error cancels the pending correction');
const external = notice('Scheduler warning'); external.className = 'message error'; position(external, 190);
observer(); finishFrames();
assert.equal(sounds.length, 6, 'A fresh observer-discovered alert plays when already visible');
external.textContent = 'Scheduler updated'; external.className = 'message'; observer(); observer();
assert.equal(sounds.length, 7, 'A new observer-discovered success banner sounds once');

const passive = notice('Contact loading'); passive.className = 'notice'; position(passive, 200);
observer(); passive.textContent = 'Contact loaded'; observer();
assert.equal(sounds.length, 7, 'Passive inline status changes stay silent');
passive.textContent = 'Attachment failed'; passive.setAttribute('role', 'alert');
passive.scrollIntoView = () => { errorTop = 210; }; errorTop = 950;
api.presentInline(passive, {block:'center'}); api.presentInline(passive, {block:'center'});
assert.equal(sounds.length, 8, 'Explicit inline snaps present the same alert only once');
passive.textContent = 'Another error'; api.presentInline(passive, {block:'nearest'});
assert.equal(sounds.length, 9, 'A new inline error already in position plays');
position(external, 950); external.className = 'message error';
external.scrollIntoView = () => { errorTop = 320; }; external.textContent = 'Dialog error';
api.presentInline(external, {block:'nearest'}); errorTop = 950; observer(); finishFrames();
assert.equal(errorTop, 950); assert.equal(sounds.length, 10, 'The observer leaves a dialog-owned reveal alone');
const prepared = notice('Validation prepared while the workspace was hidden');
prepared.className='message error'; position(prepared, 200);
prepared.getClientRects = () => []; api.show(prepared);
prepared.getClientRects = () => [{}]; observer(); finishFrames();
assert.equal(sounds.length, 10, 'Switching to a workspace with a preconstructed alert stays silent');
api.show(prepared); observer(); finishFrames();
assert.equal(sounds.length, 11, 'Explicitly presenting that alert in the visible workspace plays once');
const payrollWarning = notice('Recorded break warning');
payrollWarning.className = 'message error'; payrollWarning.setAttribute('data-notification-passive','');
position(payrollWarning, 950); const beforeWarning = scrolls.length;
observer(); finishFrames();
assert.equal(scrolls.length,beforeWarning,'A persisted payroll warning never scrolls the page during a redraw');
assert.equal(sounds.length,11,'Rendering saved payroll warnings stays silent');
document.querySelectorAll = () => { throw Error('Document-wide notification rescan'); };
observer([{type:'characterData',target:new Element('span'),addedNodes:[]}]);
assert.equal(sounds.length, 11, 'Unrelated mutations do not play audio');
console.log('Visible and offscreen notification presentation, sticky header, focus corrections and sound isolation passed.');
