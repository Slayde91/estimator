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
  "The installation was executed flawlessly with no delays, coordination issues or late payment. Then we wrote the test report.",
  "Give me a Red Bull and a cigarette and I could probably spray that.",
  "The defect was minor until someone photographed it.",
  "I like to think that Penetration Specialist is code for Gigolo.",
  "The system performs impeccably in ideal conditions - a fire test laboratory.",
  "The fire will be outsmarted by the concession in our performance solution.",
  "The building is now protected by a robust layer of professional opinion.",
  "The fire engineer has reviewed the issue and the fire is expected to cooperate.",
  "Any future flames should refer to the approved performance solution before proceeding.",
  "The defect is now compliant with the broader intent of everyone wanting to move on.",
  "The risk is tolerable, particularly from the office.",
  "The opening has achieved compliance through superior documentation.",
  "I don’t believe in common sense unless it has a report number.",
  "I’ll believe it when someone with letters after their name puts it in writing.",
  "I don’t need proof; I need a well-crafted paragraph that sounds like proof.",
  "Experience is useful, but have you considered getting an engineer to say the same thing?",
  "Every project has the same deadline, which was yesterday.",
  "The customer is always right, particularly when it comes to an expensive variation.",
  "I trust the laws of physics, but I’d still like that confirmed in writing.",
  "Sun Tzu said: the strongest defence is a professionally worded opinion.",
  "Explaining my job takes longer than just letting people think I’m a firefighter.",
  "I don’t run into burning buildings, but I do complain about the holes in them beforehand.",
  "I’m not a firefighter, but I do spend a suspicious amount of time talking about fire.",
  "Just think of it like insurance, except it only lasts for 120 minutes.",
  "I don't need a depth gauge when I have a perfectly good set of eyes.",
  "Proper Preparation Prevents Piss-Poor Performance",
];
function harness({ random = 0, previous, reduced = false, blocked = false, missing = false, missingCursor = false, missingMotion = false } = {}) {
  const label = { textContent: '' }, sizer = { children: [], get textContent() { return this.children.map(line => line.textContent).join(''); }, replaceChildren(...lines) { this.children = lines; } }, cursor = { hidden: false }, frames = [], timers = new Map(), writes = [];
  let current = '', last = previous, nextTimer = 0, preference, pagehide, now = 0;
  const typed = { get textContent() { return current; }, set textContent(value) { current = value; frames.push(value); } };
  const elements = { 'header-tagline-label': label, 'header-tagline-sizer': sizer, 'header-tagline-typed': typed };
  const motion = { matches: reduced, addEventListener(name, callback) { assert.equal(name, 'change'); preference = callback; } };
  let mediaTimer = null; const media = { playing: false, starts: 0, closed: false, start() { context.clearTimeout(mediaTimer); this.starts++; this.playing = !this.closed && !motion.matches; }, finish() { context.clearTimeout(mediaTimer); mediaTimer = context.setTimeout(() => this.stop(), 5000); }, stop() { context.clearTimeout(mediaTimer); this.playing = false; }, close() { this.closed = true; this.stop(); } };
  const context = {
    document: {
      getElementById(id) { return missing ? null : elements[id]; },
      querySelector(selector) { assert.equal(selector, '#header-tagline .header-tagline-cursor'); return missing || missingCursor ? null : cursor; },
      createElement(tag) { assert.equal(tag, 'span'); return { textContent: '' }; },
    },
    window: {
      CeasefireHeaderTaglineMedia: media,
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
    setTimeout(callback, delay) { assert.ok(delay === 35 || delay === 1000 || delay === 5000); timers.set(++nextTimer, { callback, delay, deadline: now + delay }); return nextTimer; },
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
  return { label, sizer, typed, cursor, media, frames, timers, writes, run, tick, finishTyping, finish, advance, nextPhrase() { context.window.CeasefireHeaderTagline.next(); },
    now: () => now, changeMotion(matches = true) { motion.matches = matches; preference({ matches }); }, pagehide() { pagehide(); } };
}
let passed = 0;
for (let index = 0; index < phrases.length; index++) {
  const h = harness({ random: (index + .01) / phrases.length }), phrase = phrases[index];
  assert.equal(h.label.textContent, phrase); assert.deepEqual(h.sizer.children.map(line => line.textContent), phrases.map(line => line + '_'));
  assert.equal(h.typed.textContent, Array.from(phrase)[0]); assert.deepEqual(h.writes, [phrase]);
  assert.equal(h.media.playing, true, 'The supplied character starts with phrase typing');
  h.finishTyping();
  assert.equal(h.now(), (Array.from(phrase).length - 1) * 35);
  assert.equal(h.cursor.hidden, true, 'Cursor stops as soon as the final character prints');
  assert.equal(h.media.playing, true, 'The supplied character continues after the final character');
  assert.equal(h.typed.textContent, phrase); assert.equal(h.label.textContent, phrase);
  assert.deepEqual(h.frames, ['', ...Array.from(phrase, (_, i) => Array.from(phrase).slice(0, i + 1).join(''))]);
  assert.equal(h.timers.size, 1);
  const finishedFrames = h.frames.slice();
  h.advance(999); assert.equal(h.cursor.hidden, true); assert.equal(h.typed.textContent, phrase);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.media.playing, true);
  h.advance(3999); assert.equal(h.media.playing, true); h.advance(1); assert.equal(h.media.playing, false); assert.equal(h.timers.size, 0);
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
  assert.deepEqual(h.frames, ['', phrases[0]]); assert.equal(h.cursor.hidden, true);
  assert.equal(h.media.playing, false, 'Reduced-motion presentation never starts character playback');
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), []);
  h.advance(999); assert.equal(h.cursor.hidden, true);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.typed.textContent, phrases[0]); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness({ previous: phrases[0], random: .999, reduced: true });
  assert.equal(h.label.textContent, phrases.at(-1)); assert.equal(h.typed.textContent, phrases.at(-1)); h.advance(1000);
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
  h.advance(999); assert.equal(h.typed.textContent, current); assert.equal(h.cursor.hidden, true);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.media.playing, true); h.advance(4000); assert.equal(h.timers.size, 0); assert.equal(h.writes.length, 0); passed++;
}
{
  const h = harness(); h.finish(); const first = h.label.textContent;
  h.nextPhrase(); assert.notEqual(h.label.textContent, first); assert.equal(h.cursor.hidden, false);
  h.finishTyping(); h.advance(999); assert.equal(h.cursor.hidden, true); h.advance(1); assert.equal(h.cursor.hidden, true);
  assert.equal(h.writes.length, 2); passed++;
}
{
  const h = harness({ reduced: true }); h.advance(4000); const first = h.label.textContent;
  h.nextPhrase(); assert.notEqual(h.label.textContent, first); assert.equal(h.typed.textContent, h.label.textContent);
  h.advance(999); assert.equal(h.cursor.hidden, true); h.advance(1); assert.equal(h.cursor.hidden, true); passed++;
}
{
  const h = harness(); h.advance(70); h.changeMotion();
  assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.cursor.hidden, true);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), []);
  h.advance(500); h.changeMotion(); h.changeMotion(false);
  h.advance(499); assert.equal(h.cursor.hidden, true);
  h.advance(1); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.finishTyping(); h.advance(0); h.changeMotion();
  h.advance(999); assert.equal(h.cursor.hidden, true);
  h.advance(1); assert.equal(h.cursor.hidden, true); h.changeMotion(false); h.changeMotion();
  assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0); passed++;
}
{
  const h = harness(); h.tick(); h.pagehide(); const frames = h.frames.slice();
  assert.equal(h.typed.textContent, h.label.textContent); assert.equal(h.cursor.hidden, true); assert.equal(h.timers.size, 0);
  assert.equal(h.media.playing, false); assert.equal(h.media.closed, true);
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
assert.match(html, /id="header-tagline-character"[^>]*alt=""[^>]*aria-hidden="true"/, 'The decorative supplied character stays out of the accessibility tree');
assert.match(html, /id="header-tagline-label" class="sr-only"/);
assert.match(html, /class="header-tagline-visual" aria-hidden="true"/);
assert.match(html, /id="header-tagline-sizer"[^>]*aria-hidden="true"/);
assert.match(html, /class="header-tagline-cursor">_<\/span>/);
assert.match(fs.readFileSync('static/styles.css', 'utf8'), /\[hidden\]\{display:none!important\}/, 'Expired cursor is hidden by the shared CSS rule');
assert.ok(!html.match(/id="header-tagline"[^>]*(?:aria-live|role="status")/), 'Typing must not repeatedly announce characters');
console.log(`Header navigation tagline UI checks passed: ${passed}`);
