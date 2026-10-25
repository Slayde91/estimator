"use strict";
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../.."), output = process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(root, ".runtime/browser-qa", `header-menu-sounds-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sourceFiles = ["static/header-menu-sounds.js", "static/index.html", "estimator/server.py", "scripts/build_windows.py", "static/sounds/mgs1-menu-move.mp3", "static/sounds/mgs-confirm2.mp3", "tests/browser/header_menu_sounds.cjs", "tests/browser/header_menu_sounds_fixture.py"];
const digest = value => createHash("sha256").update(value).digest("hex");
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
const evidence = { passed: false, source_sha256: sourceHashes(), normal_autoplay_policy: true, autoplay_override_flags: [], physical_audibility_claimed: false, checks: {}, errors: [], blocked_requests: [], assets: [] };
const server = spawn(process.env.CEASEFIRE_PYTHON || "python", [path.join(__dirname, "header_menu_sounds_fixture.py"), "--directory", output], { cwd: root, windowsHide: true });
let logs = "", browser, page;
server.stderr.on("data", data => logs += data);
const started = new Promise((resolve, reject) => {
  let text = ""; const timer = setTimeout(() => reject(Error(logs || "Fixture startup timed out")), 120000);
  server.stdout.on("data", data => { text += data; if (text.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(text.split("\n")[0])); } });
  server.once("error", error => { clearTimeout(timer); reject(error); });
  server.once("exit", code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const snapshot = () => page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectFingerprint(), penetration: window.CeasefirePenetrations.projectFingerprint(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details() }));
const idle = () => page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; });
async function played(source, prior) {
  await page.waitForFunction(({ source, prior }) => window.qaMenuAudio.playing.filter(row => row.source === source && row.trusted).length > prior, { source, prior });
}
(async () => {
  const info = await started; assert.notEqual(info.port, 8765); evidence.port = info.port;
  const origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true }); // No autoplay-policy override.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on("pageerror", error => evidence.errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && !["GET", "HEAD"].includes(request.method()) && !/^\/api\/(?:calculate|penetration\/(?:definition|calculate)|calculators\/[^/]+\/(?:worksheet|calculate))$/.test(url.pathname)) {
      evidence.blocked_requests.push({ method: request.method(), path: url.pathname }); await route.abort(); return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    window.qaMenuAudio = { media: [], calls: [], playing: [], pointers: [], csp: [] };
    document.addEventListener("pointerenter", event => {
      if (event.target.matches?.(".app-header nav button")) window.qaMenuAudio.pointers.push({ type: event.pointerType, label: event.target.textContent.trim() });
    }, true);
    document.addEventListener("securitypolicyviolation", event => window.qaMenuAudio.csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    const nativeLoad = HTMLMediaElement.prototype.load, nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.load = function (...args) {
      if (new URL(this.src, location.href).pathname.startsWith("/sounds/")) {
        window.qaMenuAudio.media.push(this);
        this.addEventListener("playing", event => window.qaMenuAudio.playing.push({ source: new URL(this.src).pathname, trusted: event.isTrusted }));
      }
      return Reflect.apply(nativeLoad, this, args);
    };
    HTMLMediaElement.prototype.play = function (...args) {
      const row = { source: new URL(this.src).pathname, readyState: this.readyState, activation: navigator.userActivation.hasBeenActive, event: window.event?.type || null, outcome: "pending" };
      window.qaMenuAudio.calls.push(row);
      try {
        const result = Reflect.apply(nativePlay, this, args);
        result.then(() => { row.outcome = "fulfilled"; }, error => { row.outcome = "rejected"; row.error = error.name; });
        return result;
      } catch (error) { row.outcome = "thrown"; row.error = error.name; throw error; }
    };
  });
  await page.goto(origin, { waitUntil: "load" });
  // Playwright's ordinary page.evaluate carries a DevTools user gesture. Keep
  // this first-hover observation unactivated by using read-only protocol probes.
  const protocol = await context.newCDPSession(page);
  async function unactivatedProbe(expression) {
    const reply = await protocol.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false });
    if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  await expect.poll(() => unactivatedProbe("Boolean(window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy && window.ClassifireBoot?.state === 'ready' && window.qaMenuAudio.media.length === 2 && window.qaMenuAudio.media.every(media => media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0))"), { timeout: 30000 }).toBe(true);
  evidence.checks.preloadedDecodedMedia = await unactivatedProbe("window.qaMenuAudio.media.map(media => ({source:new URL(media.src).pathname,readyState:media.readyState,duration:media.duration,preload:media.preload}))");
  for (const [file, expected] of [["mgs1-menu-move.mp3", "ac2d686c78fa5dabc2415a0f3b39f4ced124f5fc1613ba3918e06daa7b47f8d0"], ["mgs-confirm2.mp3", "e9e7e156e24a4fde706f922ee135e88df51dc5ba94eed6344e66bbd6298e3e86"]]) {
    const response = await page.request.get(`${origin}/sounds/${file}`), bytes = await response.body();
    assert.equal(response.status(), 200); assert.equal(response.headers()["content-type"], "audio/mpeg"); assert.equal(digest(bytes), expected);
    evidence.assets.push({ url: response.url(), status: response.status(), sha256: digest(bytes), size: bytes.length, content_type: response.headers()["content-type"] });
  }
  const before = await unactivatedProbe("({calculators:window.CeasefireCalculators.projectFingerprint(),penetration:window.CeasefirePenetrations.projectFingerprint(),pricing:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})"), home = page.locator('.app-header nav [data-view="home"]');
  assert.equal(await unactivatedProbe("navigator.userActivation.hasBeenActive"), false);
  const homeCentre = await unactivatedProbe("(() => { const bounds=document.querySelector('.app-header nav [data-view=home]').getBoundingClientRect(); return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}; })()");
  // Send genuine pointer movement without Playwright's actionability evaluation,
  // which also supplies a DevTools gesture in Chromium before the hover.
  await protocol.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await protocol.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...homeCentre });
  await expect.poll(() => unactivatedProbe("Boolean(window.qaMenuAudio.calls.length && window.qaMenuAudio.calls[0].outcome !== 'pending')")).toBe(true);
  evidence.checks.firstHoverPolicyObservation = await unactivatedProbe("({...window.qaMenuAudio.calls[0]})");
  assert.equal(evidence.checks.firstHoverPolicyObservation.source, "/sounds/mgs1-menu-move.mp3");
  assert.equal(evidence.checks.firstHoverPolicyObservation.activation, false);
  // A real click supplies activation; the native playing event proves decoding/playback, not speaker output.
  let prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("mgs-confirm2.mp3")).length);
  await home.click(); await played("/sounds/mgs-confirm2.mp3", prior); await idle();
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("mgs1-menu-move.mp3")).length);
  await page.locator('.app-header nav [data-view="help"]').hover(); await played("/sounds/mgs1-menu-move.mp3", prior);
  evidence.checks.postGestureNativePlaying = true;
  const submenu = page.locator("#calculator-navigation-toggle"); await submenu.hover(); await expect(page.locator("#calculator-navigation-menu")).toBeVisible();
  await page.locator("#steel-calculator-navigation-toggle").hover(); await expect(page.locator("#steel-calculator-navigation-menu")).toBeVisible();
  prior = await page.evaluate(() => window.qaMenuAudio.calls.length);
  await page.locator('#steel-calculator-navigation-menu [data-calculator-id="steel_factors"]').hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.length), prior + 1, "Nested submenu hover plays once, without ancestor bubbling");
  await page.mouse.move(0, 0); await home.focus();
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("mgs-confirm2.mp3")).length);
  await home.press("Enter"); await played("/sounds/mgs-confirm2.mp3", prior); await idle();
  evidence.checks.keyboardClickAndNestedHover = true;
  await page.mouse.move(0, 0);
  prior = await page.evaluate(() => window.qaMenuAudio.calls.length);
  await page.locator(".app-header .brand").hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.length), prior, "Header controls outside navigation stay silent");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, "header-menu-audio.png") });
  assert.deepEqual(await snapshot(), before, "Menu audio preserves the entire initialized calculator, pricing and project draft");
  evidence.checks.draftsPreserved = true;
  evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio.calls, playing: window.qaMenuAudio.playing, csp: window.qaMenuAudio.csp }));
  assert.deepEqual(evidence.audio_events.csp, []); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blocked_requests, []);
  evidence.source_sha256_after = sourceHashes(); assert.deepEqual(evidence.source_sha256_after, evidence.source_sha256);
  evidence.limits = ["Native media playing events and exact decoded assets are verified; physical speaker audibility and hardware latency are not measured.", "The first hover policy result is this fresh browser observation only; browsers may block unactivated audio. Blocked or unloaded interactions are never queued for later playback.", "Only a fresh owned browser context and random-port fixture were used; the live application and existing tabs were untouched."];
  evidence.passed = true; fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, output, port: info.port, firstHover: evidence.checks.firstHoverPolicyObservation }));
})().catch(async error => {
  evidence.failure = String(error.stack || error); evidence.source_sha256_after = sourceHashes();
  if (page) { evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio?.calls, playing: window.qaMenuAudio?.playing, pointers: window.qaMenuAudio?.pointers, media: window.qaMenuAudio?.media.map(media => ({ source: media.src, readyState: media.readyState, error: media.error?.message, paused: media.paused })), button: { count: document.querySelectorAll(".app-header nav button").length, disabled: document.querySelector('.app-header nav [data-view="home"]')?.disabled }, csp: window.qaMenuAudio?.csp })).catch(() => null); await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); }
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(output, "server.log"), logs); });
