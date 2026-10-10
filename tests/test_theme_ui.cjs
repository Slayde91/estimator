const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/theme.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/theme.css'), 'utf8');
const key = 'ceasefire.ui.theme.v1';
function harness({ stored = null, getDenied = false, setDenied = false, absent = false } = {}) {
  const attrs = {}, buttonAttrs = {}, listeners = {}, writes = [], status = { textContent: '' };
  const button = { dataset: {}, setAttribute(name, value) { buttonAttrs[name] = value; }, addEventListener(name, fn) { assert.equal(name, 'click'); assert.equal(listeners[name], undefined); listeners[name] = fn; } };
  const forbidden = () => { throw Error('Themes must not touch project, calculator, events or requests'); };
  const context = { document: { documentElement: { setAttribute(name, value) { assert.equal(name, 'data-theme'); attrs[name] = value; } }, getElementById(id) { return id === 'theme-toggle' ? absent ? null : button : id === 'theme-status' ? status : null; }, dispatchEvent: forbidden },
    window: { localStorage: { getItem(name) { assert.equal(name, key); if (getDenied) throw Error('Denied'); return stored; }, setItem(name, value) { if (setDenied) throw Error('Denied'); writes.push([name, value]); } }, fetch: forbidden, dispatchEvent: forbidden,
      CeasefireProject: new Proxy({}, { get: forbidden }), CeasefireCalculators: new Proxy({}, { get: forbidden }), CeasefireTakeoffs: new Proxy({}, { get: forbidden }), CeasefireDesktop: new Proxy({}, { get: forbidden }) }, fetch: forbidden };
  vm.createContext(context);
  const run = () => vm.runInContext(source, context);
  run();
  return { attrs, buttonAttrs, writes, status, run, click: () => listeners.click() };
}
test('five distinct themes cycle once per activation, wrap, announce and store only their own preference', () => {
  const h = harness();
  assert.equal(h.attrs['data-theme'], 'ceasefire'); assert.equal(h.status.textContent, ''); assert.equal(h.writes.length, 0);
  for (const [id, name, next] of [['midnight','Midnight','Ocean'], ['ocean','Ocean','Forest'], ['forest','Forest','Slate'], ['slate','Slate','Ceasefire'], ['ceasefire','Ceasefire','Midnight']]) {
    h.click(); assert.equal(h.attrs['data-theme'], id);
    assert.equal(h.buttonAttrs['aria-label'], `Theme: ${name}. Next theme: ${next}.`);
    assert.equal(h.buttonAttrs.title, h.buttonAttrs['aria-label']); assert.equal(h.status.textContent, `${name} theme selected.`);
    assert.deepEqual(h.writes.at(-1), [key, id]);
  }
  assert.equal(h.writes.length, 5);
});
test('a recognized stored appearance restores without emitting writes or announcements', () => {
  const h = harness({ stored: 'forest' }); assert.equal(h.attrs['data-theme'], 'forest'); assert.equal(h.writes.length, 0); assert.equal(h.status.textContent, ''); h.click(); assert.equal(h.attrs['data-theme'], 'slate');
});
test('unknown and hostile preference strings cannot become DOM attributes or CSS', () => {
  for (const stored of ['', 'dark', 'MIDNIGHT', '__proto__', 'midnight" style="color:red']) assert.equal(harness({ stored }).attrs['data-theme'], 'ceasefire');
});
test('denied reads and writes preserve session cycling', () => {
  const h = harness({ getDenied: true, setDenied: true }); for (let i=0;i<5;i++) h.click(); assert.equal(h.attrs['data-theme'], 'ceasefire'); assert.equal(h.writes.length, 0);
});
test('a blocked localStorage property itself is handled', () => {
  const context = { document: { documentElement: { setAttribute() {} }, getElementById(id) { return id === 'theme-toggle' ? { dataset: {}, setAttribute() {}, addEventListener(name, fn) { context.click = fn; } } : null; } }, window: {} };
  Object.defineProperty(context.window, 'localStorage', { get() { throw Error('Denied'); } }); vm.createContext(context); vm.runInContext(source, context); assert.doesNotThrow(() => context.click());
});
test('initializing twice never registers a second activation or touches domain state', () => { const h = harness(); h.run(); h.click(); assert.equal(h.attrs['data-theme'], 'midnight'); assert.equal(h.writes.length, 1); });
test('pages without the theme control remain untouched', () => { assert.doesNotThrow(() => harness({ absent: true })); });
function luminance(hex) { if(hex.length===4) hex='#'+[...hex.slice(1)].map(v=>v+v).join(''); const components = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return .2126*components[0]+.7152*components[1]+.0722*components[2]; }
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('theme button colors and standard text meet 4.5:1 contrast, without image or canvas filters', () => {
  assert.ok(contrast('#b90a15','#ffffff') >= 4.5);
  for (const id of ['midnight','ocean','forest','slate']) {
    const block = css.match(new RegExp(`:root\\[data-theme="${id}"\\] \\{([^}]+)\\}`))[1];
    const value = name => block.match(new RegExp(`--${name}:\\s*(#[a-f\\d]{3}(?:[a-f\\d]{3})?)\\b`, 'i'))[1];
    assert.ok(contrast(value('theme-button'),'#ffffff') >= 4.5, id+' button');
    assert.ok(contrast(value('ink'),value('paper')) >= 4.5, id+' text');
    assert.ok(contrast(value('muted'),value('paper')) >= 4.5, id+' helper text');
    assert.ok(contrast(value('accent'),value('paper')) >= 4.5, id+' links');
    assert.ok(contrast(value('theme-border'),value('theme-input')) >= 3, id+' input boundary');
  }
  assert.doesNotMatch(css, /(?:filter|mix-blend-mode)\s*:/); assert.doesNotMatch(css, /(?:canvas|img)\s*\{/);
});
test('control is native, outside navigation/project actions and independent of Takeoffs edition blocks', () => {
  const html = fs.readFileSync(path.join(root,'static/index.html'),'utf8');
  assert.match(html, /<button id="theme-toggle" type="button"/); assert.match(html, /<script src="\/theme.js" defer>/); assert.match(html, /<link rel="stylesheet" href="\/theme.css">/);
  const nav = html.slice(html.indexOf('<nav aria-label="Main navigation">'), html.indexOf('</nav>')); assert.doesNotMatch(nav, /theme-toggle/);
  for (const block of html.matchAll(/<!-- TAKEOFFS:START -->([\s\S]*?)<!-- TAKEOFFS:END -->/g)) assert.doesNotMatch(block[1], /theme-toggle|theme\.js|theme\.css/);
});
