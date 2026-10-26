"use strict";
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../.."), output = process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(root, ".runtime/browser-qa", `header-menu-sounds-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sourceFiles = ["static/header-menu-sounds.js", "static/downloads.js", "static/app.js", "estimator/server.py", "static/sounds/mgs1-menu-move.mp3", "static/sounds/mgs-confirm2.mp3", "static/sounds/new-explosion.mp3", "static/sounds/hover.mp3", "static/sounds/select.mp3", "static/sounds/select-2.mp3", "static/sounds/mixkit-vintage-dot-printing-1371.wav", "static/sounds/checkpoint.ogg", "static/sounds/loading.mp3", "tests/browser/header_menu_sounds.cjs", "tests/browser/header_menu_sounds_fixture.py"];
const digest = value => createHash("sha256").update(value).digest("hex");
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
const evidence = { passed: false, source_sha256: sourceHashes(), normal_autoplay_policy: true, autoplay_override_flags: [], physical_audibility_claimed: false, checks: {}, errors: [], blocked_requests: [], assets: [] };
const server = spawn(process.env.CEASEFIRE_PYTHON || "python", [path.join(__dirname, "header_menu_sounds_fixture.py"), "--directory", output], { cwd: root, windowsHide: true });
let logs = "", browser, page, saveRequests = 0;
const templateActions = [], heldTemplates = [];
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
    if (url.origin === origin && request.method() === "POST" && /^\/api\/calculators\/[^/]+\/template$/.test(url.pathname)) {
      const action = templateActions.shift() || {};
      if (action.hold) await new Promise(resolve => heldTemplates.push({ release: resolve, path: url.pathname }));
      if (action.fail) { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture document preparation cancelled." }) }); return; }
      await route.continue(); return;
    }
    if (url.origin === origin && url.pathname === "/api/project/save-as" && request.method() === "POST") saveRequests++;
    if (url.origin === origin && !["GET", "HEAD"].includes(request.method()) && !/^\/api\/(?:calculate|download-progress|project\/save-as|penetration\/(?:definition|calculate)|calculators\/[^/]+\/(?:worksheet|calculate))$/.test(url.pathname)) {
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
    const reply = await protocol.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: false });
    if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  await expect.poll(() => unactivatedProbe("Boolean(window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy && window.ClassifireBoot?.state === 'ready' && window.qaMenuAudio.media.length === 9 && window.qaMenuAudio.media.every(media => media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0))"), { timeout: 30000 }).toBe(true);
  evidence.checks.preloadedDecodedMedia = await unactivatedProbe("window.qaMenuAudio.media.map(media => ({source:new URL(media.src).pathname,readyState:media.readyState,duration:media.duration,preload:media.preload}))");
  for (const [file, expected] of [["mgs1-menu-move.mp3", "ac2d686c78fa5dabc2415a0f3b39f4ced124f5fc1613ba3918e06daa7b47f8d0"], ["mgs-confirm2.mp3", "e9e7e156e24a4fde706f922ee135e88df51dc5ba94eed6344e66bbd6298e3e86"], ["new-explosion.mp3", "1ed5c489c6e7ab08caacf1cba198e7aae07cb7a904be51a4800c56eb32512c21"], ["hover.mp3", "052d0d7f3fb41ddb67766dedd8f4c237b46c8b18745dfad0a73a14c8afb6fad5"], ["select.mp3", "60e089eeac138ce5301fb59dc9d649c0404a556499c8f78c15c81a7cdfde1969"], ["select-2.mp3", "37e5c8645aa76e11dc8039545940436ea9201e533b1c946fbc9dfc3845efeb7b"], ["mixkit-vintage-dot-printing-1371.wav", "5c39082dfe0aa5c24cae5faa0ba616bfb1354d8b7686b0b0784fa32689a9decf"], ["checkpoint.ogg", "60acfb941abf427378e87e7ae6660ae29491f8d5efaae2681d7eb9a52af3c935"], ["loading.mp3", "2c245208c0a4e9668b36e17d16227be81f6409398de1ece8b37be648e0ac60a8"]]) {
    const response = await page.request.get(`${origin}/sounds/${file}`), bytes = await response.body();
    assert.equal(response.status(), 200); assert.equal(response.headers()["content-type"], file.endsWith(".wav") ? "audio/wav" : file.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg"); assert.equal(digest(bytes), expected);
    evidence.assets.push({ url: response.url(), status: response.status(), sha256: digest(bytes), size: bytes.length, content_type: response.headers()["content-type"] });
  }
  await unactivatedProbe("(async () => { await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]); return true; })()");
  const before = await unactivatedProbe("({calculators:window.CeasefireCalculators.projectFingerprint(),penetration:window.CeasefirePenetrations.projectFingerprint(),pricing:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})"), home = page.locator('.app-header nav [data-view="home"]');
  assert.equal(await unactivatedProbe("navigator.userActivation.hasBeenActive"), false);
  const homeCentre = await unactivatedProbe("(() => { const bounds=document.querySelector('.app-header nav [data-view=home]').getBoundingClientRect(); return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}; })()");
  const firstHoverStart = await unactivatedProbe("window.qaMenuAudio.calls.length");
  // Send genuine pointer movement without Playwright's actionability evaluation,
  // which also supplies a DevTools gesture in Chromium before the hover.
  await protocol.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await protocol.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...homeCentre });
  await expect.poll(() => unactivatedProbe(`Boolean(window.qaMenuAudio.calls.slice(${firstHoverStart}).some(row => row.source === '/sounds/mgs1-menu-move.mp3' && row.outcome !== 'pending'))`)).toBe(true);
  evidence.checks.firstHoverPolicyObservation = await unactivatedProbe(`({...window.qaMenuAudio.calls.slice(${firstHoverStart}).find(row => row.source === '/sounds/mgs1-menu-move.mp3')})`);
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
  // Home cards retain the header clips, rather than the ordinary button pair.
  await home.click(); await idle();
  const homeHelp = page.locator('#view-home [data-home-view="help"]');
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("mgs1-menu-move.mp3")).length);
  await homeHelp.hover(); await played("/sounds/mgs1-menu-move.mp3", prior);
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("mgs-confirm2.mp3")).length);
  await homeHelp.click(); await played("/sounds/mgs-confirm2.mp3", prior); await idle();
  evidence.checks.homeCardsShareHeaderClips = true;
  // A real ordinary control exercises delegated native pointer/click events.
  await page.locator('.app-header nav [data-view="settings"]').click(); await idle();
  const theme = page.locator("#theme-toggle");
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("hover.mp3")).length);
  await theme.hover(); await played("/sounds/hover.mp3", prior);
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select-2.mp3")).length);
  await theme.click(); await played("/sounds/select-2.mp3", prior);
  evidence.checks.otherPageHoverAndSelect2 = true;
  // The real global Save action is cancelled by the private fixture's chooser.
  // Its feedback belongs to the click, not to success or the page behind it.
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("checkpoint.ogg")).length);
  const beforeSaveCalls = await page.evaluate(() => window.qaMenuAudio.calls.length);
  await page.locator("#save-current-project").click(); await played("/sounds/checkpoint.ogg", prior);
  await expect(page.locator("#app-message")).toContainText("Save cancelled. Your current project remains open.", { timeout: 60000 });
  await expect(page.locator("#save-current-project")).toBeEnabled();
  assert.equal(saveRequests, 1);
  assert.deepEqual(await page.evaluate(start => window.qaMenuAudio.calls.slice(start).filter(row => row.event === "click").map(row => row.source), beforeSaveCalls), ["/sounds/checkpoint.ogg"]);
  evidence.checks.globalSaveCheckpointWithoutGenericOverlap = true;
  // These owned lightweight controls isolate delegated routing from Takeoff
  // document/session operations, which have their own browser acceptance gates.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog"); dialog.id = "qa-takeoff-audio-dialog";
    const button = document.createElement("button"); button.textContent = "Audio routing check"; button.id = "qa-takeoff-audio-button";
    const icon = document.createElement("span"); icon.textContent = "Nested icon"; icon.id = "qa-takeoff-audio-icon";
    button.append(icon); dialog.append(button); document.body.append(dialog); document.body.classList.add("takeoffs-active"); dialog.showModal();
  });
  const scoped = page.locator("#qa-takeoff-audio-button");
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select.mp3")).length);
  await scoped.click(); await played("/sounds/select.mp3", prior);
  await page.evaluate(() => document.body.classList.remove("takeoffs-active"));
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select-2.mp3")).length);
  await scoped.click(); await played("/sounds/select-2.mp3", prior);
  const hoverCount = await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("hover.mp3")).length);
  await page.locator("#qa-takeoff-audio-icon").hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("hover.mp3")).length), hoverCount, "Moving within a dynamic button is silent");
  await page.evaluate(() => { const dialog = document.getElementById("qa-takeoff-audio-dialog"); dialog.close(); dialog.remove(); });
  evidence.checks.dynamicTakeoffModalAndOtherContextRouting = true;
  // A genuine calculator Document action exercises the shared preparation,
  // progress and native file-save receipt. Hold its export request so a fast
  // machine cannot hide a loop that accidentally ends before preparation.
  await submenu.hover(); await page.locator("#steel-calculator-navigation-toggle").hover();
  await page.locator('#steel-calculator-navigation-menu [data-calculator-id="steel_board"]').click(); await idle();
  await page.locator("#calculator-document-toggle").click();
  templateActions.push({ hold: true });
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("loading.mp3")).length);
  await page.locator("#calculator-template").click();
  await expect.poll(() => heldTemplates.length).toBe(1); await played("/sounds/loading.mp3", prior);
  await expect(page.locator(".document-download-progress")).toBeVisible();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.media.find(audio => audio.src.endsWith("loading.mp3")).paused), false);
  const templateResponse = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/calculators/steel_board/template" && reply.request().method() === "POST");
  heldTemplates[0].release(); const templateReceipt = await (await templateResponse).json();
  assert.equal(templateReceipt.saved, true);
  const templateRelative = path.relative(output, templateReceipt.path);
  assert.ok(templateRelative && !templateRelative.startsWith("..") && !path.isAbsolute(templateRelative));
  assert.equal(fs.readFileSync(templateReceipt.path).subarray(0, 2).toString(), "PK");
  await expect(page.locator("#calculator-template")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.qaMenuAudio.media.find(audio => audio.src.endsWith("loading.mp3")).paused)).toBe(true);
  evidence.checks.realDocumentDownloadLoopsUntilNativeSave = { filename: templateReceipt.filename, destination: templateReceipt.destination };
  // Independent Document consumers share the same downloader. Native owned
  // controls trigger two real requests; one success must not silence the other,
  // and the final cancellation must release the loop without creating a file.
  await page.evaluate(() => {
    const menu = document.createElement("div"); menu.id = "qa-concurrent-documents"; menu.className = "calculator-document-menu";
    window.qaMenuAudio.exportResults = [];
    for (let index = 0; index < 2; index++) {
      const button = document.createElement("button"); button.id = `qa-export-${index}`; button.textContent = `Fixture Document ${index + 1}`;
      button.addEventListener("click", () => { void window.CeasefireDownloads.save("/api/calculators/steel_board/template", {}, { button }).then(saved => window.qaMenuAudio.exportResults.push({ index, saved }), error => window.qaMenuAudio.exportResults.push({ index, error: error.message })); });
      menu.append(button);
    }
    document.body.append(menu);
  });
  templateActions.push({ hold: true }, { hold: true, fail: true });
  const beforeConcurrent = await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("loading.mp3")).length);
  await page.locator("#qa-export-0").click(); await expect.poll(() => heldTemplates.length).toBe(2);
  await page.locator("#qa-export-1").click(); await expect.poll(() => heldTemplates.length).toBe(3);
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("loading.mp3")).length), beforeConcurrent + 1);
  heldTemplates[1].release();
  await page.waitForFunction(() => window.qaMenuAudio.exportResults.some(result => result.index === 0));
  assert.equal(await page.evaluate(() => window.qaMenuAudio.media.find(audio => audio.src.endsWith("loading.mp3")).paused), false);
  heldTemplates[2].release();
  await page.waitForFunction(() => window.qaMenuAudio.exportResults.length === 2);
  await expect.poll(() => page.evaluate(() => window.qaMenuAudio.media.find(audio => audio.src.endsWith("loading.mp3")).paused)).toBe(true);
  const concurrent = await page.evaluate(() => window.qaMenuAudio.exportResults);
  assert.equal(concurrent.find(result => result.index === 0).saved.saved, true);
  assert.match(concurrent.find(result => result.index === 1).error, /cancelled/);
  await page.evaluate(() => document.getElementById("qa-concurrent-documents").remove());
  evidence.checks.concurrentDocumentSuccessAndCancellation = true;
  await page.mouse.move(0, 0);
  prior = await page.evaluate(() => window.qaMenuAudio.calls.length);
  await page.locator(".app-header .brand").hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.length), prior, "The logo has no hover sound");
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("new-explosion.mp3")).length);
  await page.locator(".app-header .brand").click(); await played("/sounds/new-explosion.mp3", prior); await idle();
  evidence.checks.logoClickExplosion = true;
  // Taglines still type after a trusted click, but never request printing playback.
  await home.click(); await idle();
  const printingObservation = await page.waitForFunction(() => {
    const typed = document.getElementById("header-tagline-typed").textContent;
    const label = document.getElementById("header-tagline-label").textContent;
    if (!typed.length || typed === label) return false;
    return {
      typed, label,
      paused: window.qaMenuAudio.media.find(audio => audio.src.endsWith("mixkit-vintage-dot-printing-1371.wav")).paused,
      attempts: window.qaMenuAudio.calls.filter(row => row.source.endsWith("mixkit-vintage-dot-printing-1371.wav")).length,
    };
  });
  const silentPrinting = await printingObservation.jsonValue();
  await printingObservation.dispose();
  assert.ok(silentPrinting.typed.length > 0 && silentPrinting.typed !== silentPrinting.label);
  assert.equal(silentPrinting.paused, true); assert.equal(silentPrinting.attempts, 0);
  await page.waitForFunction(() => document.getElementById("header-tagline-typed").textContent === document.getElementById("header-tagline-label").textContent);
  assert.equal(await page.evaluate(() => window.qaMenuAudio.media.find(audio => audio.src.endsWith("mixkit-vintage-dot-printing-1371.wav")).paused), true);
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("mixkit-vintage-dot-printing-1371.wav")).length), 0, "No printing playback attempt occurs anywhere in the native journey");
  evidence.checks.silentTaglineTyping = { ...silentPrinting, finished: true };
  assert.ok((await page.evaluate(() => window.qaMenuAudio.calls.filter(row => !row.source.endsWith("mixkit-vintage-dot-printing-1371.wav"))))
    .every(row => ["pointerenter", "pointerover", "click"].includes(row.event)), "Button playback attempts occur in their input event");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, "header-menu-audio.png") });
  assert.deepEqual(await snapshot(), before, "Menu audio preserves the entire initialized calculator, pricing and project draft");
  evidence.checks.draftsPreserved = true;
  evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio.calls, playing: window.qaMenuAudio.playing, csp: window.qaMenuAudio.csp }));
  assert.deepEqual(evidence.audio_events.csp, []); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blocked_requests, []);
  evidence.source_sha256_after = sourceHashes(); assert.deepEqual(evidence.source_sha256_after, evidence.source_sha256);
  evidence.limits = ["Native media playing events and exact decoded assets are verified; physical speaker audibility and hardware latency are not measured.", "The first hover policy result is this fresh browser observation only; browsers may block unactivated audio. Blocked or unloaded button interactions are never queued for later playback.", "Takeoff/modal context routing and concurrent exports use owned lightweight DOM controls; the representative calculator Document export and global Save cancellation use the real application controls.", "Only a fresh owned browser context and random-port fixture with a private download destination were used; the live application and existing tabs were untouched."];
  evidence.passed = true; fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, output, port: info.port, firstHover: evidence.checks.firstHoverPolicyObservation }));
})().catch(async error => {
  evidence.failure = String(error.stack || error); evidence.source_sha256_after = sourceHashes();
  if (page) { evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio?.calls, playing: window.qaMenuAudio?.playing, pointers: window.qaMenuAudio?.pointers, media: window.qaMenuAudio?.media.map(media => ({ source: media.src, readyState: media.readyState, error: media.error?.message, paused: media.paused })), button: { count: document.querySelectorAll(".app-header nav button").length, disabled: document.querySelector('.app-header nav [data-view="home"]')?.disabled }, csp: window.qaMenuAudio?.csp })).catch(() => null); await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); }
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(output, "server.log"), logs); });
