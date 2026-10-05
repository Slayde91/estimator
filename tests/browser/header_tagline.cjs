const { chooseLibrary } = require('./section_navigation.cjs');
// Header presentation and successful navigation against a disposable fixture.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `header-tagline-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const assets = ['static/app.js', 'static/styles.css', 'static/index.html'];
const assetHashes = Object.fromEntries(assets.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const phrase = "I'm an expert at reading plans and looking at photos - a site visit would just be a waste of my time.";
const newPhrase = 'The fire was outsmarted by the concession in our performance solution.';
const errors = [], evidence = {}, csp = [];
const pendingRequests = new WeakMap();
const clockOrigin = Date.parse('2026-10-04T00:00:00Z');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function instrument(context, { random = 2 / 28 + .001, blocked = false } = {}) {
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
      italic: getComputedStyle(tag).fontStyle, alignment: getComputedStyle(tag).textAlign, overflow: document.documentElement.scrollWidth - innerWidth,
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
    assert.equal(sample.cursorHidden, sample.typed === expected);
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
    assert.equal(sample.accessible, expected); assert.equal(sample.cursorHidden, sample.typed === expected);
    samples.push(sample);
  }
  assert.equal(samples.at(-1).typed, expected, 'The production typing timers must finish the exact phrase');
  assert.ok(samples.length >= 3, 'The real DOM must show progressive typing');
  assert.equal(samples.at(-1).finished?.phrase, expected);
  return samples;
}
async function expireCursor(initial, expected) {
  const stopped = await layout(); sameHeader(initial, stopped);
  assert.equal(stopped.cursorHidden, true, 'The underscore must disappear with the final character');
  assert.equal(stopped.cursorDisplay, 'none'); assert.equal(stopped.cursorAnimationCount, 0, 'Hidden cursor must have no running CSS animation');
  assert.equal(stopped.typed, expected); assert.equal(stopped.accessible, expected);
  await page.clock.runFor(500);
  const atHalfSecond = await layout(); sameHeader(initial, atHalfSecond);
  assert.equal(atHalfSecond.typed, expected); assert.equal(atHalfSecond.cursorHidden, true);
  await page.clock.runFor(500);
  const afterOneSecond = await layout(); sameHeader(initial, afterOneSecond);
  assert.equal(afterOneSecond.cursorHidden, true); assert.equal(afterOneSecond.cursorAnimationCount, 0);
  await page.clock.runFor(10000);
  const later = await layout(); assert.equal(later.cursorHidden, true); assert.equal(later.cursorAnimationCount, 0);
  return { stopped, atHalfSecond, afterOneSecond, later };
}
async function presentationNavigation(initial) {
  // Initialize every synthetic calculator before comparing fingerprints so
  // choosing a workspace cannot be confused with a project-data change.
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  const snapshot = () => page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details() }));
  const baseline = await snapshot(), changes = [];
  const sections = [['Home', '#view-home'], ['Estimates', '#view-estimate'], ['Calculators', '#view-calculators'], ['Takeoffs', '#view-takeoffs'], ['Libraries', '#view-pricing'], ['Projects', '#view-quotes'], ['Help', '#view-help']];
  for (const [name, selector] of sections) for (const repeated of [false, true]) {
    const previous = await page.locator('#header-tagline-label').textContent();
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator(selector)).toBeVisible();
    await expect.poll(() => page.locator('#header-tagline-label').textContent()).not.toBe(previous);
    const started = await layout(), next = started.accessible; sameHeader(initial, started);
    await typeUntilFinished(started, next, await bootstrap(started, next)); await idle(); await clean();
    assert.deepEqual(await snapshot(), baseline, 'Header and navigation must retain every initialized project draft');
    changes.push({ section: name, repeated, previous, next });
  }
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const home = await layout(); await typeUntilFinished(home, home.accessible, await bootstrap(home, home.accessible));
  await page.locator('[data-home-view="calculators"]').click();
  await expect(page.locator('#view-calculators')).toBeVisible();
  await expect.poll(() => page.locator('#header-tagline-label').textContent()).not.toBe(home.accessible);
  const card = await layout(); sameHeader(initial, card);
  await typeUntilFinished(card, card.accessible, await bootstrap(card, card.accessible)); await clean(); assert.deepEqual(await snapshot(), baseline);
  const toggle = page.locator('#calculator-navigation-toggle'), menu = page.locator('#calculator-navigation-menu');
  const beforeHover = await layout(); await toggle.hover(); await expect(menu).toBeVisible();
  assert.equal((await layout()).accessible, beforeHover.accessible); assert.deepEqual((await layout()).finished, beforeHover.finished);
  await page.mouse.move(0, 0); await expect(menu).toBeHidden();
  const previous = beforeHover.accessible;
  await toggle.hover(); await menu.getByRole('button', { name: 'Steel (board)', exact: true }).click();
  await expect(page.locator('#calculator-title')).toHaveText('Steel (board)');
  await expect.poll(() => page.locator('#header-tagline-label').textContent()).not.toBe(previous);
  const selected = await layout(); sameHeader(initial, selected);
  await typeUntilFinished(selected, selected.accessible, await bootstrap(selected, selected.accessible));
  await idle(); await clean(); assert.deepEqual(await snapshot(), baseline);

  // A canceled existing Pricing Library guard must retain the same phrase,
  // completion deadline and drafts for both main-nav and menu navigation.
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect.poll(() => page.locator('#header-tagline-label').textContent()).not.toBe(selected.accessible);
  const library = await layout(); await typeUntilFinished(library, library.accessible, await bootstrap(library, library.accessible));
  await chooseLibrary(page, 'pricing'); await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first();
  await price.fill('789.12345'); await price.press('Tab');
  const guarded = await snapshot(), beforeCancel = await layout(), display = await price.inputValue();
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Help', exact: true }).click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('#view-pricing')).toBeVisible();
  assert.equal((await layout()).accessible, beforeCancel.accessible); assert.deepEqual((await layout()).finished, beforeCancel.finished); assert.deepEqual(await snapshot(), guarded);
  await toggle.hover(); await menu.getByRole('button', { name: 'Steel (board)', exact: true }).click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await layout()).accessible, beforeCancel.accessible); assert.deepEqual((await layout()).finished, beforeCancel.finished); assert.deepEqual(await snapshot(), guarded); await expect(price).toHaveValue(display);
  await toggle.hover(); await menu.getByRole('button', { name: 'Steel (board)', exact: true }).click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => page.locator('#header-tagline-label').textContent()).not.toBe(beforeCancel.accessible);
  const accepted = await layout(); sameHeader(initial, accepted);
  await typeUntilFinished(accepted, accepted.accessible, await bootstrap(accepted, accepted.accessible));
  assert.deepEqual(await snapshot(), guarded); await expireCursor(accepted, accepted.accessible);
  return { changes, homeCardRefreshes: true, hoverDoesNotRefresh: true, menuSelectionRefreshes: true, canceledMainAndMenuRetainPhraseAndDeadline: true, acceptedMenuRefreshes: true, initializedDraftsRetained: true };
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
    assert.equal(initial.alignment, 'center'); assert.ok(Math.abs(initial.tagline.x + initial.tagline.width / 2 - initial.nav.x - initial.nav.width / 2) < .1, 'Tagline is centered beneath navigation');
    const typingBlink = await blinking(initial, phrase, 'during typing');
    await page.screenshot({ path: path.join(output, `tagline-typing-${width}.png`), fullPage: false });
    const samples = await typeUntilFinished(initial, phrase, await bootstrap(initial, phrase));
    await idle(); await clean();
    const accessibility = await page.locator('#header-tagline').ariaSnapshot();
    assert.ok(accessibility.includes(phrase)); assert.ok(!accessibility.includes('_'));
    const expiry = await expireCursor(initial, phrase);
    await page.screenshot({ path: path.join(output, `tagline-${width}.png`), fullPage: false });
    evidence[width] = { sampleCount: samples.length, typingBlink, initial, final: samples.at(-1), expiry, accessibility, dirty: false, centered: true };
    if (width === 1146) {
      evidence.navigation = await presentationNavigation(initial);
      const previous = await page.locator('#header-tagline-label').textContent();
      await page.reload();
      const second = await page.locator('#header-tagline-label').textContent(); assert.notEqual(second, previous);
      const nextInitial = await layout();
      await typeUntilFinished(nextInitial, second, await bootstrap(nextInitial, second)); await clean();
      evidence.reload = { first: previous, second, consecutiveRepeatAvoided: true };
    }
    csp.push(...await page.evaluate(() => window.qaCsp)); await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1146, height: 900 } });
    await instrument(context, { random: 21 / 28 + .001 }); // Twenty-eight choices, no previous phrase: first new phrase at index 21.
    page = await context.newPage(); watch(page); await installPausedClock();
    await page.goto(`http://127.0.0.1:${info.port}/`); await page.evaluate(() => document.fonts.ready);
    const initial = await layout(); assert.equal(initial.accessible, newPhrase);
    assert.ok(newPhrase.startsWith(initial.typed)); assert.notEqual(initial.typed, newPhrase);
    const typingBlink = await blinking(initial, newPhrase, 'while typing a newly added phrase');
    const samples = await typeUntilFinished(initial, newPhrase, await bootstrap(initial, newPhrase));
    await idle(); await clean();
    const expiry = await expireCursor(initial, newPhrase);
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
  for (const name of assets) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), assetHashes[name], `${name} changed during native acceptance`);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, fixturePort: info.port, assetHashes, evidence, errors, csp,
    limits: ['Disposable browser fixture only; no live port 8765 interaction.', 'Playwright clock advances production JS typing/expiry callbacks; CSS opacity transitions are sampled in real Chromium frames.', 'All 28 exact phrases and preference-change timer cancellation are additionally verified by focused unit checks.'] }, null, 2));
  console.log(`Header navigation tagline browser acceptance passed: ${output}`);
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
