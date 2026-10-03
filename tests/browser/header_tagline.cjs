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
const errors = [], evidence = {}, csp = [];
async function layout() {
  return page.evaluate(() => {
    const rectangle = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
    const tag = document.querySelector('#header-tagline'), cursor = tag.querySelector('.header-tagline-cursor');
    return { header: rectangle('.app-header'), nav: rectangle('.app-header nav'), tagline: rectangle('#header-tagline'),
      cursorAnimation: getComputedStyle(cursor).animationName, cursorOpacity: getComputedStyle(cursor).opacity,
      italic: getComputedStyle(tag).fontStyle, overflow: document.documentElement.scrollWidth - innerWidth,
      typed: document.querySelector('#header-tagline-typed').textContent,
      accessible: document.querySelector('#header-tagline-label').textContent };
  });
}
function sameHeader(first, next) {
  for (const region of ['header', 'nav', 'tagline']) for (const key of ['x', 'y', 'width', 'height', 'bottom'])
    assert.ok(Math.abs(first[region][key] - next[region][key]) < .1, `${region}.${key} changed while typing`);
}
async function idle() { await page.waitForFunction(() => { const s = window.CeasefireDesktop?.status(); return s?.ready && !s.busy; }); }
async function clean() {
  assert.equal(await page.evaluate(() => window.CeasefireDesktop.status().dirty), false);
  await expect(page.locator('#project-save-state')).toHaveText('Not saved to a file');
}
function watch(current) {
  current.on('pageerror', error => errors.push(error.message));
  current.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  for (const width of [1600, 1146, 764, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => {
      Math.random = () => .14; window.qaCsp = [];
      document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective));
    });
    page = await context.newPage(); page.setDefaultTimeout(30000); watch(page);
    const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.equal(response.status(), 200);
    assert.match(response.headers()['content-security-policy'], /(?:^|;\s*)script-src 'self'(?:;|$)/);
    await page.evaluate(() => document.fonts.ready);
    const initial = await layout(); assert.equal(initial.accessible, phrase); assert.equal(initial.italic, 'italic');
    assert.ok(phrase.startsWith(initial.typed)); assert.notEqual(initial.typed, phrase, 'Actual typing must still be in progress');
    assert.ok(initial.tagline.y >= initial.nav.bottom); assert.ok(initial.overflow <= 1);
    const samples = [initial];
    while (samples.at(-1).typed !== phrase) {
      await page.waitForTimeout(75); const sample = await layout(); sameHeader(initial, sample);
      assert.ok(phrase.startsWith(sample.typed)); assert.ok(sample.typed.length >= samples.at(-1).typed.length);
      assert.equal(sample.accessible, phrase); samples.push(sample);
    }
    const cursorStates = [...new Set(samples.map(sample => sample.cursorOpacity))].sort();
    assert.ok(samples.length >= 3); assert.equal(samples.at(-1).cursorAnimation, 'header-tagline-blink');
    assert.deepEqual(cursorStates, ['0', '1'], 'The underscore must actually alternate between visible and hidden');
    await idle(); await clean();
    const accessibility = await page.locator('#header-tagline').ariaSnapshot();
    assert.ok(accessibility.includes(phrase)); assert.ok(!accessibility.includes('_'));
    const beforeNavigation = await page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint() }));
    await page.getByRole('button', { name: 'Quote', exact: true }).click(); await idle(); await clean();
    assert.equal((await layout()).accessible, phrase); assert.equal((await layout()).typed, phrase);
    assert.deepEqual(await page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint() })), beforeNavigation);
    await page.screenshot({ path: path.join(output, `tagline-${width}.png`), fullPage: false });
    evidence[width] = { sampleCount: samples.length, cursorStates, initial, final: samples.at(-1), accessibility, dirty: false, navigationDoesNotReroll: true };
    if (width === 1146) {
      await page.reload(); await idle();
      const second = await page.locator('#header-tagline-label').textContent(); assert.notEqual(second, phrase);
      await expect(page.locator('#header-tagline-typed')).toHaveText(second); await clean();
      evidence.reload = { first: phrase, second, consecutiveRepeatAvoided: true };
    }
    csp.push(...await page.evaluate(() => window.qaCsp)); await context.close();
  }
  for (const blocked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ blocked }) => {
      Math.random = () => .14;
      if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } });
    }, { blocked });
    page = await context.newPage(); watch(page); await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
    const reduced = await layout(); assert.equal(reduced.typed, phrase); assert.equal(reduced.accessible, phrase);
    assert.equal(reduced.cursorAnimation, 'none'); await clean();
    evidence[blocked ? 'blockedStorage' : 'reducedMotion'] = { fullPhraseImmediately: true, cursorAnimation: reduced.cursorAnimation, dirty: false };
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, fixturePort: info.port, evidence, errors, csp,
    limits: ['Disposable browser fixture only; no live port 8765 interaction.', 'All 15 exact phrases and preference-change timer cancellation are additionally verified by focused unit checks.'] }, null, 2));
  console.log(`Header launch tagline browser acceptance passed: ${output}`);
})().catch(async error => {
  console.error(error); if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
