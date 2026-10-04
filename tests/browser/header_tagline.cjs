// Launch-only presentation against a disposable real Estimator fixture.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `header-tagline-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const phrase = "I'm an expert at reading plans and looking at photos - a site visit would just be a waste of my time.";
const newPhrase = 'Fire testing proves the system works; construction proves how creative people can be.';
const errors = [], evidence = {}, csp = [];
const pendingRequests = new WeakMap();
const clockOrigin = Date.parse('2026-10-04T00:00:00Z');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function instrument(context, { random = .12, blocked = false } = {}) {
  await context.addInitScript(({ random, blocked }) => {
    Math.random = () => random;
    window.qaCsp = [];
    window.qaHeaderFinished = null;
    document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective));
    new MutationObserver(() => {
      const label = document.querySelector('#header-tagline-label'), typed = document.querySelector('#header-tagline-typed');
      // Ignore the complete HTML fallback once the launch script chooses its actual phrase.
      if (window.qaHeaderFinished && window.qaHeaderFinished.phrase !== label?.textContent) window.qaHeaderFinished = null;
      if (!window.qaHeaderFinished && label?.textContent && typed?.textContent === label.textContent)
        window.qaHeaderFinished = { at: performance.now(), phrase: label.textContent };
    }).observe(document, { childList: true, subtree: true, characterData: true });
    if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  }, { random, blocked });
}
async function installPausedClock() {
  // The browser owns CSS blinking; this clock controls the production JS timers only.
  // Pausing before loading also prevents slow CI startup from finishing the phrase early.
  await page.clock.install({ time: clockOrigin });
  await page.clock.pauseAt(clockOrigin + 60000);
}
async function layout() {
  return page.evaluate(() => {
    const rectangle = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
    const tag = document.querySelector('#header-tagline'), cursor = tag.querySelector('.header-tagline-cursor');
    return { header: rectangle('.app-header'), nav: rectangle('.app-header nav'), tagline: rectangle('#header-tagline'),
      cursorAnimation: getComputedStyle(cursor).animationName, cursorOpacity: getComputedStyle(cursor).opacity,
      cursorHidden: cursor.hidden, cursorDisplay: getComputedStyle(cursor).display, cursorAnimationCount: cursor.getAnimations().length,
      italic: getComputedStyle(tag).fontStyle, overflow: document.documentElement.scrollWidth - innerWidth,
      typed: document.querySelector('#header-tagline-typed').textContent,
      accessible: document.querySelector('#header-tagline-label').textContent,
      now: performance.now(), finished: window.qaHeaderFinished };
  });
}
function sameHeader(first, next) {
  for (const region of ['header', 'nav', 'tagline']) for (const key of ['x', 'y', 'width', 'height', 'bottom'])
    assert.ok(Math.abs(first[region][key] - next[region][key]) < .1, `${region}.${key} changed while typing`);
}
async function idle() {
  // Poll from the test process; page.waitForFunction's rAF polling pauses with the page clock.
  await expect.poll(() => page.evaluate(() => { const s = window.CeasefireDesktop?.status(); return !!(s?.ready && !s.busy); }), { timeout: 30000 }).toBe(true);
}
async function bootstrap(initial, expected) {
  await expect.poll(() => page.evaluate(() => !!window.CeasefireDesktop?.status().ready), { timeout: 30000 }).toBe(true);
  const samples = [initial];
  // Wait for actual responses before advancing each existing 180ms quote debounce.
  // Async initialization can schedule another debounce after an earlier one has fired.
  for (let attempt = 0; attempt < 20; attempt++) {
    await expect.poll(() => pendingRequests.get(page).size, { timeout: 30000 }).toBe(0);
    await delay(40);
    if (await page.evaluate(() => { const s = window.CeasefireDesktop.status(); return s.ready && !s.busy; })) return samples;
    await page.clock.runFor(200);
    const sample = await layout(); sameHeader(initial, sample);
    assert.ok(expected.startsWith(sample.typed));
    assert.ok(sample.typed.length >= samples.at(-1).typed.length); samples.push(sample);
    assert.equal(sample.cursorHidden, false);
    assert.ok(!sample.finished || sample.now - sample.finished.at <= 4000, 'Startup draining must retain the cursor deadline checks');
  }
  await idle();
  return samples;
}
async function clean() {
  assert.equal(await page.evaluate(() => window.CeasefireDesktop.status().dirty), false);
  await expect(page.locator('#project-save-state')).toHaveText('Not saved to a file');
}
function watch(current) {
  const pending = new Set(); pendingRequests.set(current, pending);
  current.on('request', request => pending.add(request));
  current.on('requestfinished', request => pending.delete(request));
  current.on('requestfailed', request => pending.delete(request));
  current.on('pageerror', error => errors.push(error.message));
  current.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}
async function blinking(initial, expected, stage) {
  const states = new Set(), samples = [];
  for (let index = 0; index < 25 && states.size < 2; index++) {
    const sample = await layout(); sameHeader(initial, sample);
    assert.equal(sample.cursorHidden, false, `Cursor was hidden ${stage}`);
    assert.equal(sample.cursorAnimation, 'header-tagline-blink');
    assert.equal(sample.accessible, expected);
    states.add(sample.cursorOpacity); samples.push(sample);
    // Node time remains real even while the page clock is paused. These are real CSS frames.
    if (states.size < 2) await delay(80);
  }
  assert.deepEqual([...states].sort(), ['0', '1'], `The underscore must actually blink ${stage}`);
  return { states: [...states].sort(), samples: samples.length };
}
async function typeUntilFinished(initial, expected, samples = [initial]) {
  for (let index = 0; samples.at(-1).typed !== expected && index < 300; index++) {
    await page.clock.runFor(70);
    const sample = await layout(); sameHeader(initial, sample);
    assert.ok(expected.startsWith(sample.typed));
    assert.ok(sample.typed.length >= samples.at(-1).typed.length);
    assert.equal(sample.accessible, expected); assert.equal(sample.cursorHidden, false);
    samples.push(sample);
  }
  assert.equal(samples.at(-1).typed, expected, 'The production typing timers must finish the exact phrase');
  assert.ok(samples.length >= 3, 'The real DOM must show progressive typing');
  assert.equal(samples.at(-1).finished?.phrase, expected);
  return samples;
}
async function advanceFromFinish(milliseconds) {
  const current = await layout(); assert.ok(current.finished, 'Completion must be observed before measuring cursor expiry');
  const elapsed = current.now - current.finished.at;
  assert.ok(elapsed <= milliseconds, `Already past the requested completion-relative time: ${elapsed}`);
  await page.clock.runFor(milliseconds - elapsed);
  const next = await layout();
  assert.ok(Math.abs(next.now - next.finished.at - milliseconds) < .1);
  return next;
}
async function expireCursor(initial, expected, { animated = true, navigate = false } = {}) {
  const atFourSeconds = await advanceFromFinish(4000); sameHeader(initial, atFourSeconds);
  assert.equal(atFourSeconds.typed, expected); assert.equal(atFourSeconds.cursorHidden, false);
  const afterFinishBlink = animated ? await blinking(initial, expected, 'four seconds after the final character') : null;
  if (!animated) assert.equal(atFourSeconds.cursorAnimation, 'none');
  if (navigate) {
    await idle(); await clean();
    const before = await page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint() }));
    await page.getByRole('button', { name: 'Quote', exact: true }).click(); await idle(); await clean();
    const after = await layout();
    assert.equal(after.typed, expected); assert.equal(after.accessible, expected);
    assert.deepEqual(after.finished, atFourSeconds.finished, 'Navigation must not restart completion or reroll the phrase');
    assert.deepEqual(await page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint() })), before);
  }
  const beforeDeadline = await advanceFromFinish(4999); assert.equal(beforeDeadline.cursorHidden, false);
  const stopped = await advanceFromFinish(5000); sameHeader(initial, stopped);
  assert.equal(stopped.cursorHidden, true, 'The underscore must disappear exactly five seconds after completion');
  assert.equal(stopped.cursorDisplay, 'none'); assert.equal(stopped.cursorAnimationCount, 0, 'Hidden cursor must have no running CSS animation');
  assert.equal(stopped.typed, expected); assert.equal(stopped.accessible, expected);
  await page.clock.runFor(10000);
  const later = await layout(); assert.equal(later.cursorHidden, true); assert.equal(later.cursorAnimationCount, 0);
  return { atFourSeconds, afterFinishBlink, beforeDeadline, stopped, later, navigationDoesNotRestartOrReroll: navigate };
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  for (const width of [1600, 1146, 764, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await instrument(context);
    page = await context.newPage(); page.setDefaultTimeout(30000); watch(page);
    await installPausedClock();
    const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.equal(response.status(), 200);
    assert.match(response.headers()['content-security-policy'], /(?:^|;\s*)script-src 'self'(?:;|$)/);
    await page.evaluate(() => document.fonts.ready);
    const initial = await layout(); assert.equal(initial.accessible, phrase); assert.equal(initial.italic, 'italic');
    assert.ok(phrase.startsWith(initial.typed)); assert.notEqual(initial.typed, phrase, 'Actual typing must still be in progress');
    assert.ok(initial.tagline.y >= initial.nav.bottom); assert.ok(initial.overflow <= 1);
    const typingBlink = await blinking(initial, phrase, 'during typing');
    await page.screenshot({ path: path.join(output, `tagline-typing-${width}.png`), fullPage: false });
    const samples = await typeUntilFinished(initial, phrase, await bootstrap(initial, phrase));
    await idle(); await clean();
    const accessibility = await page.locator('#header-tagline').ariaSnapshot();
    assert.ok(accessibility.includes(phrase)); assert.ok(!accessibility.includes('_'));
    const expiry = await expireCursor(initial, phrase, { navigate: true });
    await page.screenshot({ path: path.join(output, `tagline-${width}.png`), fullPage: false });
    evidence[width] = { sampleCount: samples.length, typingBlink, initial, final: samples.at(-1), expiry, accessibility, dirty: false, navigationDoesNotReroll: true };
    if (width === 1146) {
      await page.reload();
      const second = await page.locator('#header-tagline-label').textContent(); assert.notEqual(second, phrase);
      const nextInitial = await layout();
      await typeUntilFinished(nextInitial, second, await bootstrap(nextInitial, second)); await clean();
      evidence.reload = { first: phrase, second, consecutiveRepeatAvoided: true };
    }
    csp.push(...await page.evaluate(() => window.qaCsp)); await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1146, height: 900 } });
    await instrument(context, { random: .84 }); // Eighteen choices, no previous phrase: index 15.
    page = await context.newPage(); watch(page); await installPausedClock();
    await page.goto(`http://127.0.0.1:${info.port}/`); await page.evaluate(() => document.fonts.ready);
    const initial = await layout(); assert.equal(initial.accessible, newPhrase);
    assert.ok(newPhrase.startsWith(initial.typed)); assert.notEqual(initial.typed, newPhrase);
    const typingBlink = await blinking(initial, newPhrase, 'while typing a newly added phrase');
    const samples = await typeUntilFinished(initial, newPhrase, await bootstrap(initial, newPhrase));
    await idle(); await clean();
    const expiry = await expireCursor(initial, newPhrase, { navigate: true });
    await page.screenshot({ path: path.join(output, 'tagline-new-phrase.png'), fullPage: false });
    evidence.newPhrase = { expected: newPhrase, sampleCount: samples.length, typingBlink, expiry, dirty: false };
    csp.push(...await page.evaluate(() => window.qaCsp)); await context.close();
  }
  for (const blocked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await instrument(context, { blocked });
    page = await context.newPage(); watch(page); await installPausedClock(); await page.goto(`http://127.0.0.1:${info.port}/`); await page.evaluate(() => document.fonts.ready);
    const reduced = await layout(); assert.equal(reduced.typed, phrase); assert.equal(reduced.accessible, phrase);
    assert.equal(reduced.cursorAnimation, 'none'); await bootstrap(reduced, phrase); await clean();
    const expiry = await expireCursor(reduced, phrase, { animated: false }); await clean();
    evidence[blocked ? 'blockedStorage' : 'reducedMotion'] = { fullPhraseImmediately: true, cursorAnimation: reduced.cursorAnimation, expiry, dirty: false };
    csp.push(...await page.evaluate(() => window.qaCsp));
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, fixturePort: info.port, evidence, errors, csp,
    limits: ['Disposable browser fixture only; no live port 8765 interaction.', 'Playwright clock advances production JS typing/expiry callbacks; CSS opacity transitions are sampled in real Chromium frames.', 'All 18 exact phrases and preference-change timer cancellation are additionally verified by focused unit checks.'] }, null, 2));
  console.log(`Header launch tagline browser acceptance passed: ${output}`);
})().catch(async error => {
  console.error(error); if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
    fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(await page.evaluate(() => ({ desktop: window.CeasefireDesktop?.status(),
      busy: [...document.querySelectorAll('[aria-busy="true"]')].map(element => ({ id: element.id, tag: element.tagName })),
      calculators: window.CeasefireCalculators?.hasPendingOperation?.(), penetration: window.CeasefirePenetrations?.hasPendingOperation?.(),
      libraries: window.CeasefireLibraryEditor?.hasPendingOperation?.(), finished: window.qaHeaderFinished, now: performance.now() })).catch(() => ({})), null, 2));
  }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
