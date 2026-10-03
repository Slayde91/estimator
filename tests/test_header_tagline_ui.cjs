const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const app = fs.readFileSync('static/app.js', 'utf8');
const source = app.split('// HEADER_TAGLINE:START')[1]?.split('// HEADER_TAGLINE:END')[0];
assert.ok(source, 'The isolated presentation initializer must exist in the packaged app script');
const phrases = [
  "Built on caffeine and the audacity of 'Do your best, mastic the rest.'",
  "Made for deadlines and the belief that 'There’s a tested system for that… probably.'",
  "I'm an expert at reading plans and looking at photos - a site visit would just be a waste of my time.",
  "Every penetration has a story, and most of them end in mastic.",
  "The tested detail looked great right up until installation.",
  "Some call it non-compliant; we call it 'pending clarification.'",
  "Every defect starts with 'It was like that when we got here.'",
  "The wall was fire-rated before the services arrived.",
  "Built to the drawing, adjusted to reality.",
  "The services were coordinated perfectly, just not with the wall.",
  "Behind every neat firestop is an opening that nearly ruined someone’s day.",
  "A tested system exists for everything except what we found on site.",
  "Measure twice, discover the drawing is wrong anyway.",
  "The architect drew the wall; the services drew their own conclusions.",
  "The drawing said “typical,” which was optimistic.",
];
function harness({ random = 0, previous, reduced = false, blocked = false, missing = false } = {}) {
  const label = { textContent: '' }, sizer = { textContent: '' }, frames = [], timers = new Map(), writes = [];
  let current = '', last = previous, nextTimer = 0, preference, pagehide;
  const typed = { get textContent() { return current; }, set textContent(value) { current = value; frames.push(value); } };
  const elements = { 'header-tagline-label': label, 'header-tagline-sizer': sizer, 'header-tagline-typed': typed };
  const motion = { matches: reduced, addEventListener(name, callback) { assert.equal(name, 'change'); preference = callback; } };
  const context = {
    document: { getElementById(id) { return missing ? null : elements[id]; } },
    window: {
      localStorage: {
        getItem(key) { assert.equal(key, 'ceasefire.headerTagline.last'); if (blocked) throw Error('Storage denied'); return last; },
        setItem(key, value) { assert.equal(key, 'ceasefire.headerTagline.last'); if (blocked) throw Error('Storage denied'); writes.push(value); last = value; },
      },
      matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion; },
      addEventListener(name, callback, options) { assert.equal(name, 'pagehide'); assert.equal(options.once, true); pagehide = callback; },
      CeasefireProject: { changed() { throw Error('Presentation must never dirty a project'); } },
      dispatchEvent() { throw Error('Presentation must not emit input or change events'); },
    },
    Math: Object.create(Math),
    setTimeout(callback, delay) { assert.equal(delay, 35); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  context.Math.random = () => random;
  vm.createContext(context);
  const run = () => vm.runInContext(source, context);
  const tick = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); };
  const finish = () => { while (timers.size) tick(); };
  run();
  return { label, sizer, typed, frames, timers, writes, run, tick, finish,
    changeMotion() { preference({ matches: true }); }, pagehide() { pagehide(); } };
}
let passed = 0;
for (let index = 0; index < phrases.length; index++) {
  const h = harness({ random: (index + .01) / phrases.length }), phrase = phrases[index];
  assert.equal(h.label.textContent, phrase); assert.equal(h.sizer.textContent, phrase + '_');
  assert.equal(h.typed.textContent, Array.from(phrase)[0]); assert.deepEqual(h.writes, [phrase]);
  h.finish();
  assert.equal(h.typed.textContent, phrase); assert.equal(h.label.textContent, phrase);
  assert.deepEqual(h.frames, ['', ...Array.from(phrase, (_, i) => Array.from(phrase).slice(0, i + 1).join(''))]);
  passed++;
}
{
  const h = harness(); h.finish(); const first = h.label.textContent;
  h.run(); h.finish(); assert.notEqual(h.label.textContent, first); assert.equal(h.writes.length, 2); passed++;
}
{
  const h = harness({ previous: 'Unrecognized old value', reduced: true });
  assert.equal(h.label.textContent, phrases[0]); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ previous: phrases[0], random: .999, reduced: true });
  assert.equal(h.label.textContent, phrases.at(-1)); assert.equal(h.typed.textContent, phrases.at(-1)); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ blocked: true }); h.finish(); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.writes.length, 0); passed++;
}
{
  const h = harness(); h.tick(); h.changeMotion(); assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.pagehide(); assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ missing: true }); assert.equal(h.timers.size, 0); assert.equal(h.writes.length, 0); passed++;
}
const html = fs.readFileSync('static/index.html', 'utf8');
assert.match(html, /id="header-tagline-label" class="sr-only"/);
assert.match(html, /class="header-tagline-visual" aria-hidden="true"/);
assert.match(html, /id="header-tagline-sizer"[^>]*aria-hidden="true"/);
assert.ok(!html.match(/id="header-tagline"[^>]*(?:aria-live|role="status")/), 'Typing must not repeatedly announce characters');
console.log(`Header launch tagline UI checks passed: ${passed}`);
