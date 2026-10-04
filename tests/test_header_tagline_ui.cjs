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
  "Fire testing proves the system works; construction proves how creative people can be.",
  "The installation was executed flawlessly; then we wrote a test report.",
  "Give me a red bull and a cigarette and I could probably spray that.",
];
function harness({ random = 0, previous, reduced = false, blocked = false, missing = false, missingCursor = false, missingMotion = false } = {}) {
  const label = { textContent: '' }, sizer = { children: [], get textContent() { return this.children.map(line => line.textContent).join(''); }, replaceChildren(...lines) { this.children = lines; } }, cursor = { hidden: false }, frames = [], timers = new Map(), writes = [];
  let current = '', last = previous, nextTimer = 0, preference, pagehide, now = 0;
  const typed = { get textContent() { return current; }, set textContent(value) { current = value; frames.push(value); } };
  const elements = { 'header-tagline-label': label, 'header-tagline-sizer': sizer, 'header-tagline-typed': typed };
  const motion = { matches: reduced, addEventListener(name, callback) { assert.equal(name, 'change'); preference = callback; } };
  const context = {
    document: {
      getElementById(id) { return missing ? null : elements[id]; },
      querySelector(selector) { assert.equal(selector, '#header-tagline .header-tagline-cursor'); return missing || missingCursor ? null : cursor; },
      createElement(tag) { assert.equal(tag, 'span'); return { textContent: '' }; },
    },
    window: {
      localStorage: {
        getItem(key) { assert.equal(key, 'ceasefire.headerTagline.last'); if (blocked) throw Error('Storage denied'); return last; },
        setItem(key, value) { assert.equal(key, 'ceasefire.headerTagline.last'); if (blocked) throw Error('Storage denied'); writes.push(value); last = value; },
      },
      matchMedia: missingMotion ? undefined : query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion; },
      addEventListener(name, callback, options) { assert.equal(name, 'pagehide'); assert.equal(options.once, true); pagehide = callback; },
      CeasefireProject: { changed() { throw Error('Presentation must never dirty a project'); } },
      CeasefireCalculators: { completeProjectSnapshot() { throw Error('Presentation must never access calculator state'); } },
      dispatchEvent() { throw Error('Presentation must not emit input or change events'); },
    },
    Math: Object.create(Math),
    setTimeout(callback, delay) { assert.ok(delay === 35 || delay === 5000); timers.set(++nextTimer, { callback, delay, deadline: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  context.Math.random = () => random;
  vm.createContext(context);
  const run = () => vm.runInContext(source, context);
  const next = () => [...timers.entries()].sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0];
  const advance = milliseconds => {
    assert.ok(milliseconds >= 0);
    const target = now + milliseconds;
    while (timers.size && next()[1].deadline <= target) {
      const [id, timer] = next(); timers.delete(id); now = timer.deadline; timer.callback();
    }
    now = target;
  };
  const tick = () => { assert.ok(timers.size); advance(next()[1].deadline - now); };
  const finishTyping = () => {
    while (typed.textContent !== label.textContent) {
      assert.equal(next()?.[1].delay, 35, 'Only typing is scheduled before the final character'); tick();
    }
  };
  const finish = () => { finishTyping(); advance(5000); };
  run();
  return { label, sizer, typed, cursor, frames, timers, writes, run, tick, finishTyping, finish, advance, nextPhrase() { context.window.CeasefireHeaderTagline.next(); },
    now: () => now, changeMotion(matches = true) { motion.matches = matches; preference({ matches }); }, pagehide() { pagehide(); } };
}
let passed = 0;
for (let index = 0; index < phrases.length; index++) {
  const h = harness({ random: (index + .01) / phrases.length }), phrase = phrases[index];
  assert.equal(h.label.textContent, phrase); assert.deepEqual(h.sizer.children.map(line => line.textContent), phrases.map(line => line + '_'));
  assert.equal(h.typed.textContent, Array.from(phrase)[0]); assert.deepEqual(h.writes, [phrase]);
  h.finishTyping();
  assert.equal(h.now(), (Array.from(phrase).length - 1) * 35);
  assert.equal(h.cursor.hidden, false, 'Cursor stays visible through the actual final character');
  assert.equal(h.typed.textContent, phrase); assert.equal(h.label.textContent, phrase);
  assert.deepEqual(h.frames, ['', ...Array.from(phrase, (_, i) => Array.from(phrase).slice(0, i + 1).join(''))]);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].deadline, h.now() + 5000);
  const finishedFrames = h.frames.slice();
  h.advance(4999); assert.equal(h.cursor.hidden, false); assert.equal(h.typed.textContent, phrase);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0);
  h.advance(10000); assert.deepEqual(h.frames, finishedFrames); assert.deepEqual(h.sizer.children.map(line => line.textContent), phrases.map(line => line + '_'));
  passed++;
}
{
  const h = harness(); h.finish(); const first = h.label.textContent;
  h.run(); h.finish(); assert.notEqual(h.label.textContent, first); assert.equal(h.writes.length, 2); passed++;
}
{
  const h = harness({ previous: 'Unrecognized old value', reduced: true });
  assert.equal(h.label.textContent, phrases[0]); assert.equal(h.typed.textContent, phrases[0]);
  assert.deepEqual(h.frames, ['', phrases[0]]); assert.equal(h.cursor.hidden, false);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [5000]);
  h.advance(4999); assert.equal(h.cursor.hidden, false);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ previous: phrases[0], random: .999, reduced: true });
  assert.equal(h.label.textContent, phrases.at(-1)); assert.equal(h.typed.textContent, phrases.at(-1)); h.advance(5000);
  assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ blocked: true }); h.finish(); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.writes.length, 0); passed++;
}
{
  const h = harness({ blocked: true }); h.tick(); const first = h.label.textContent, reserved = h.sizer.children.slice();
  h.nextPhrase(); assert.notEqual(h.label.textContent, first); assert.equal(h.timers.size, 1); assert.equal(h.cursor.hidden, false);
  assert.equal(h.typed.textContent, Array.from(h.label.textContent)[0]); assert.deepEqual(h.sizer.children, reserved);
  const second = h.label.textContent; h.nextPhrase(); assert.notEqual(h.label.textContent, second);
  h.finishTyping(); const current = h.label.textContent;
  h.advance(4999); assert.equal(h.typed.textContent, current); assert.equal(h.cursor.hidden, false);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); assert.equal(h.writes.length, 0); passed++;
}
{
  const h = harness(); h.finish(); const first = h.label.textContent;
  h.nextPhrase(); assert.notEqual(h.label.textContent, first); assert.equal(h.cursor.hidden, false);
  h.finishTyping(); h.advance(4999); assert.equal(h.cursor.hidden, false); h.advance(1); assert.equal(h.cursor.hidden, true);
  assert.equal(h.writes.length, 2); passed++;
}
{
  const h = harness({ reduced: true }); h.advance(4000); const first = h.label.textContent;
  h.nextPhrase(); assert.notEqual(h.label.textContent, first); assert.equal(h.typed.textContent, h.label.textContent);
  h.advance(4999); assert.equal(h.cursor.hidden, false); h.advance(1); assert.equal(h.cursor.hidden, true); passed++;
}
{
  const h = harness(); h.advance(70); h.changeMotion();
  assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.cursor.hidden, false);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [5000]);
  h.advance(2500); h.changeMotion(); h.changeMotion(false);
  h.advance(2499); assert.equal(h.cursor.hidden, false);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.finishTyping(); h.advance(4000); h.changeMotion();
  h.advance(999); assert.equal(h.cursor.hidden, false);
  h.advance(1); assert.equal(h.cursor.hidden, true); h.changeMotion(false); h.changeMotion();
  assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.tick(); h.pagehide(); const frames = h.frames.slice();
  assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0);
  h.changeMotion(); h.nextPhrase(); h.advance(10000); assert.deepEqual(h.frames, frames); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.finishTyping(); h.advance(1000); h.pagehide();
  assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0);
  h.changeMotion(); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ reduced: true }); h.advance(1000); h.pagehide(); h.changeMotion(false); h.changeMotion();
  h.advance(10000); assert.equal(h.cursor.hidden, true); assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.changeMotion(false); h.advance(35);
  assert.equal(h.typed.textContent, Array.from(phrases[0]).slice(0, 2).join('')); h.finish(); assert.equal(h.cursor.hidden, true); passed++;
}
{
  const h = harness({ missingMotion: true }); h.finish(); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.cursor.hidden, true); passed++;
}
{
  const h = harness({ missing: true }); assert.equal(h.timers.size, 0); assert.equal(h.writes.length, 0); passed++;
}
{
  const h = harness({ missingCursor: true }); assert.equal(h.timers.size, 0); assert.equal(h.writes.length, 0); passed++;
}
const html = fs.readFileSync('static/index.html', 'utf8');
assert.match(html, /id="header-tagline-label" class="sr-only"/);
assert.match(html, /class="header-tagline-visual" aria-hidden="true"/);
assert.match(html, /id="header-tagline-sizer"[^>]*aria-hidden="true"/);
assert.match(html, /class="header-tagline-cursor">_<\/span>/);
assert.match(fs.readFileSync('static/styles.css', 'utf8'), /\[hidden\]\{display:none!important\}/, 'Expired cursor is hidden by the shared CSS rule');
assert.ok(!html.match(/id="header-tagline"[^>]*(?:aria-live|role="status")/), 'Typing must not repeatedly announce characters');
console.log(`Header navigation tagline UI checks passed: ${passed}`);
