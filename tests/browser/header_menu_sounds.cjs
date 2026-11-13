"use strict";
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../.."), output = process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(root, ".runtime/browser-qa", `header-menu-sounds-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sourceFiles = ["static/header-menu-sounds.js", "static/downloads.js", "static/calculators.js", "static/penetration.js", "static/app.js", "estimator/server.py", "static/sounds/mgs1-menu-move.mp3", "static/sounds/mgs-confirm2.mp3", "static/sounds/flame-whoosh.wav", "static/sounds/select.mp3", "static/sounds/select-2.mp3", "static/sounds/type.mp3", "static/sounds/checkpoint.ogg", "static/sounds/gameover.mp3", "static/sounds/loading.mp3", "tests/browser/header_menu_sounds.cjs", "tests/browser/header_menu_sounds_fixture.py"];
const expectedSounds = [
  ["mgs1-menu-move.mp3", "ac2d686c78fa5dabc2415a0f3b39f4ced124f5fc1613ba3918e06daa7b47f8d0"],
  ["mgs-confirm2.mp3", "e9e7e156e24a4fde706f922ee135e88df51dc5ba94eed6344e66bbd6298e3e86"],
  ["flame-whoosh.wav", "988f40b00194f865d8ca84ef30d0d3b882c08a25a8597a9ebe2aa54524ab966b"],
  ["select.mp3", "60e089eeac138ce5301fb59dc9d649c0404a556499c8f78c15c81a7cdfde1969"],
  ["select-2.mp3", "37e5c8645aa76e11dc8039545940436ea9201e533b1c946fbc9dfc3845efeb7b"],
  ["checkpoint.ogg", "60acfb941abf427378e87e7ae6660ae29491f8d5efaae2681d7eb9a52af3c935"],
  ["gameover.mp3", "547911f8e7ddc37b8df47bf44cec988ccd6116a63a9ee87d10be6c97dd66496e"],
];
const digest = value => createHash("sha256").update(value).digest("hex");
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
const evidence = { passed: false, source_sha256: sourceHashes(), normal_autoplay_policy: true, autoplay_override_flags: [], physical_audibility_claimed: false, checks: {}, errors: [], blocked_requests: [], loading_requests: [], assets: [] };
const server = spawn(process.env.CEASEFIRE_PYTHON || "python", [path.join(__dirname, "header_menu_sounds_fixture.py"), "--directory", output], { cwd: root, windowsHide: true });
let logs = "", browser, page, saveRequests = 0;
const certificateWorkspaceRequests = [], savedCertificateWorkspaces = [];
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
async function noDownloadAudio() {
  assert.deepEqual(await page.evaluate(() => ({
    players: window.qaMenuAudio.media.filter(audio => audio.src.endsWith("loading.mp3")).length,
    attempts: window.qaMenuAudio.calls.filter(row => row.source.endsWith("loading.mp3")).length,
  })), { players: 0, attempts: 0 });
  assert.deepEqual(evidence.loading_requests, [], "No loading clip is fetched, even during concurrent exports");
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
    if (url.origin === origin && url.pathname === "/sounds/loading.mp3") evidence.loading_requests.push({ method: request.method(), path: url.pathname });
    if (url.origin === origin && request.method() === "POST" && /^\/api\/calculators\/[^/]+\/template$/.test(url.pathname)) {
      const action = templateActions.shift() || {};
      if (action.hold) await new Promise(resolve => heldTemplates.push({ release: resolve, path: url.pathname }));
      if (action.fail) { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture document preparation cancelled." }) }); return; }
      await route.continue(); return;
    }
    const certificateWorkspaceCreation = url.origin === origin && url.pathname === "/api/certifications/workspaces" && request.method() === "POST";
    if (certificateWorkspaceCreation) certificateWorkspaceRequests.push(request.postDataJSON());
    if (url.origin === origin && url.pathname === "/api/project/save-as" && request.method() === "POST") {
      saveRequests++; savedCertificateWorkspaces.push(request.postDataJSON().certifications?.workspace_id);
    }
    if (url.origin === origin && !["GET", "HEAD"].includes(request.method()) && !certificateWorkspaceCreation && !/^\/api\/(?:calculate|download-progress|project\/save-as|penetration\/(?:definition|calculate|references)|calculators\/[^/]+\/(?:worksheet|calculate))$/.test(url.pathname)) {
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
  await expect.poll(() => unactivatedProbe(`Boolean(window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy && window.ClassifireBoot?.state === 'ready' && window.qaMenuAudio.media.length === ${expectedSounds.length} && window.qaMenuAudio.media.every(media => media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0))`), { timeout: 30000 }).toBe(true);
  evidence.checks.preloadedDecodedMedia = await unactivatedProbe("window.qaMenuAudio.media.map(media => ({source:new URL(media.src).pathname,readyState:media.readyState,duration:media.duration,preload:media.preload}))");
  assert.deepEqual(evidence.checks.preloadedDecodedMedia.map(row => row.source).sort(), expectedSounds.map(([file]) => `/sounds/${file}`).sort(), "All expected sound players are present exactly once");
  assert.ok(evidence.checks.preloadedDecodedMedia.every(row => row.preload === "auto"), "Every expected sound retains automatic preload");
  for (const [file, expected] of expectedSounds) {
    const response = await page.request.get(`${origin}/sounds/${file}`), bytes = await response.body();
    assert.equal(response.status(), 200); assert.equal(response.headers()["content-type"], file.endsWith(".wav") ? "audio/wav" : file.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg"); assert.equal(digest(bytes), expected);
    evidence.assets.push({ url: response.url(), status: response.status(), sha256: digest(bytes), size: bytes.length, content_type: response.headers()["content-type"] });
  }
  await unactivatedProbe("(async () => { await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]); return true; })()");
  // Prepare complete disposable identity before capturing the domain baseline.
  // Keep this setup unactivated so the first-hover autoplay policy check still
  // observes a page without a prior user gesture.
  await unactivatedProbe(`(() => {
    for (const [id,value] of Object.entries({client:'Synthetic Audio Company','site-address':'1 Synthetic Audio Street','project-contact-name':'Synthetic Audio Contact','project-contact-phone':'0400 000 001','project-contact-email':'audio@example.test'})) {
      const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    return true;
  })()`);
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
  // Main-section buttons are silent, including Home cards and global Save.
  await home.click(); await idle();
  const buttonCalls = () => page.evaluate(() => window.qaMenuAudio.calls.filter(row => !row.source.endsWith('gameover.mp3')).length);
  let silentStart = await buttonCalls();
  const homeHelp = page.locator('#view-home [data-home-view="help"]');
  await homeHelp.hover(); await homeHelp.click(); await idle();
  assert.equal(await buttonCalls(), silentStart);
  await page.locator('.app-header nav [data-view="settings"]').click(); await idle();
  const theme = page.locator('#theme-toggle'); silentStart = await buttonCalls();
  await theme.hover(); await theme.click(); assert.equal(await buttonCalls(), silentStart);
  const beforeSaveCalls = await buttonCalls(); await page.locator('#save-current-project').click();
  await expect(page.locator('#app-message')).toContainText('Save cancelled. Your current project remains open.', {timeout:60000});
  assert.equal(await buttonCalls(), beforeSaveCalls); assert.equal(saveRequests, 1);
  evidence.checks.mainButtonsAndSaveSilent = true;
  // These owned lightweight controls isolate delegated routing from Takeoff
  // document/session operations, which have their own browser acceptance gates.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog"); dialog.id = "qa-takeoff-audio-dialog";
    const button = document.createElement("button"); button.textContent = "Audio routing check"; button.id = "qa-takeoff-audio-button";
    const icon = document.createElement("span"); icon.textContent = "Nested icon"; icon.id = "qa-takeoff-audio-icon";
    button.append(icon); dialog.append(button); document.body.append(dialog); document.body.classList.add("takeoffs-active"); dialog.showModal();
  });
  const scoped = page.locator("#qa-takeoff-audio-button");
  const beforeTakeoffHover = await buttonCalls();
  await scoped.hover(); await page.locator("#qa-takeoff-audio-icon").hover();
  assert.equal(await buttonCalls(), beforeTakeoffHover, "Takeoffs buttons issue no hover playback");
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select.mp3")).length);
  await scoped.click(); await played("/sounds/select.mp3", prior);
  await page.evaluate(() => document.body.classList.remove("takeoffs-active"));
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select-2.mp3")).length);
  await scoped.click(); assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("select-2.mp3")).length), 0);
  const hoverCount = await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("hover.mp3")).length);
  await page.locator("#qa-takeoff-audio-icon").hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith("hover.mp3")).length), hoverCount, "Moving within a dynamic button is silent");
  await page.evaluate(() => { const dialog = document.getElementById("qa-takeoff-audio-dialog"); dialog.close(); dialog.remove(); });
  evidence.checks.dynamicTakeoffModalAndOtherContextRouting = true;
  // A genuine calculator Document action exercises the shared preparation,
  // progress and native file-save receipt. Hold its export request to verify
  // preparation is silent while its visual progress remains visible.
  await submenu.hover(); await page.locator("#steel-calculator-navigation-toggle").hover();
  await page.locator('#steel-calculator-navigation-menu [data-calculator-id="steel_board"]').click(); await idle();
  const tabIds = await page.locator('#calculator-pages button[data-calculator-page]').evaluateAll(buttons => buttons.map(button => button.dataset.calculatorPage));
  assert.deepEqual(tabIds, ["CALCULATOR", "BOARD SUMMARY"], "Board exposes its schedule and purchasing summary; Settings stays hidden");
  await expect(page.locator('#calculator-pages button[data-calculator-page]')).toHaveText(["SCHEDULE", "BOARD SUMMARY"]);
  for (const id of [...tabIds.slice(1), tabIds[0]]) {
    const selected = page.locator(`#calculator-pages button[data-calculator-page="${id}"]`), original = await selected.elementHandle();
    const start = await page.evaluate(() => window.qaMenuAudio.calls.length);
    prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select-2.mp3")).length);
    await selected.click();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    assert.equal(await original.evaluate((button, id) => button === document.querySelector(`#calculator-pages button[data-calculator-page="${id}"]`), id), true, "Changing pages retains the clicked native button and its focus");
    assert.deepEqual(await page.evaluate(start => window.qaMenuAudio.calls.slice(start).filter(row => row.event === "click").map(row => row.source), start), [], "Calculator tabs stay silent");
    await original.dispose();
  }
  evidence.checks.calculatorTabNativeClickWithoutReplacementInterruption = { pages: tabIds.length, pageIds: tabIds, minimumPlaybackSeconds: 0.2 };
  await page.locator("#calculator-document-toggle").click();
  templateActions.push({ hold: true });
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("select-2.mp3")).length);
  await page.locator("#calculator-template").click();
  await expect.poll(() => heldTemplates.length).toBe(1); await noDownloadAudio();
  await expect(page.locator(".document-download-progress")).toBeVisible();
  await expect(page.locator("#calculator-template")).toBeDisabled();
  const templateResponse = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/calculators/steel_board/template" && reply.request().method() === "POST");
  heldTemplates[0].release(); const templateReceipt = await (await templateResponse).json();
  assert.equal(templateReceipt.saved, true);
  const templateRelative = path.relative(output, templateReceipt.path);
  assert.ok(templateRelative && !templateRelative.startsWith("..") && !path.isAbsolute(templateRelative));
  assert.equal(fs.readFileSync(templateReceipt.path).subarray(0, 2).toString(), "PK");
  await expect(page.locator("#calculator-template")).toBeEnabled();
  await expect(page.locator(".document-download-progress")).toHaveCount(0);
  await noDownloadAudio();
  evidence.checks.realDocumentDownloadSilentUntilNativeSave = { filename: templateReceipt.filename, destination: templateReceipt.destination, ordinaryClickPreserved: true, visualProgressPreserved: true };
  // Independent Document consumers share the same downloader. Native owned
  // controls trigger two real requests; successful and cancelled preparations
  // stay silent and retain their independent progress and receipt handling.
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
  await page.locator("#qa-export-0").click(); await expect.poll(() => heldTemplates.length).toBe(2);
  await page.locator("#qa-export-1").click(); await expect.poll(() => heldTemplates.length).toBe(3);
  await noDownloadAudio(); await expect(page.locator(".document-download-progress")).toHaveCount(2);
  heldTemplates[1].release();
  await page.waitForFunction(() => window.qaMenuAudio.exportResults.some(result => result.index === 0));
  await noDownloadAudio();
  heldTemplates[2].release();
  await page.waitForFunction(() => window.qaMenuAudio.exportResults.length === 2);
  await noDownloadAudio();
  const concurrent = await page.evaluate(() => window.qaMenuAudio.exportResults);
  assert.equal(concurrent.find(result => result.index === 0).saved.saved, true);
  assert.match(concurrent.find(result => result.index === 1).error, /cancelled/);
  await page.evaluate(() => document.getElementById("qa-concurrent-documents").remove());
  evidence.checks.concurrentDocumentSuccessAndCancellation = true;
  await submenu.hover();
  await page.locator('#calculator-navigation-menu').getByRole('button', { name: 'Firestopping', exact: true }).click(); await idle();
  silentStart = await buttonCalls();
  for (const group of ['Additional Allowances', 'Penetration']) {
    const tab = page.locator(`#penetration-input-groups button[data-penetration-group="${group}"]`);
    await tab.hover(); await tab.click(); await expect(tab).toHaveAttribute('aria-selected','true');
  }
  assert.equal(await buttonCalls(), silentStart);
  evidence.checks.calculatorTabsSilent = true;
  await page.mouse.move(0, 0);
  prior = await page.evaluate(() => window.qaMenuAudio.calls.length);
  await page.locator(".app-header .brand").hover();
  assert.equal(await page.evaluate(() => window.qaMenuAudio.calls.length), prior, "The logo has no hover sound");
  prior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith("flame-whoosh.wav")).length);
  await page.locator(".app-header .brand").click(); await played("/sounds/flame-whoosh.wav", prior); await idle();
  const logoOnset = await page.evaluate(async () => {
    const bytes = await (await fetch('/sounds/flame-whoosh.wav')).arrayBuffer();
    const context = new OfflineAudioContext(2, 1, 44100), audio = await context.decodeAudioData(bytes);
    let firstPeak = 0;
    for (let channel = 0; channel < audio.numberOfChannels; channel++)
      for (const sample of audio.getChannelData(channel).subarray(0, 441)) firstPeak = Math.max(firstPeak, Math.abs(sample));
    return { first10msPeak: firstPeak, sampleRate: audio.sampleRate, frames: audio.length, duration: audio.duration };
  });
  assert.ok(logoOnset.first10msPeak >= .01); assert.equal(logoOnset.frames, 184218);
  const logoAttempt = await page.evaluate(() => window.qaMenuAudio.calls.filter(row => row.source.endsWith('flame-whoosh.wav')).at(-1));
  assert.equal(logoAttempt.event, 'click', 'The preloaded logo clip starts in the original click handler');
  evidence.checks.logoClickTrimmedFlameWhoosh = { ...logoOnset, sameClickEvent: true, leadingSecondsRemoved: 38118 / 44100 };
  const brandPhrase = 'CLASSIFIRE: Passive Fire Intelligence', tagline = page.locator('#header-tagline-label');
  if (await tagline.textContent() === brandPhrase) { await home.click(); await expect(tagline).not.toHaveText(brandPhrase); }
  const brandPrior = await page.evaluate(() => window.qaMenuAudio.playing.filter(row => row.source.endsWith('gameover.mp3')).length);
  // The existing tagline fixture selects phrases through Math.random. Keep the
  // override only through this trusted click/label check so concurrent visual
  // callbacks cannot consume it before selection; restore it in finally.
  await page.evaluate(() => {
    const original = Math.random;
    window.qaRestoreTaglineRandom = () => { Math.random = original; delete window.qaRestoreTaglineRandom; };
    Math.random = () => .999999;
  });
  try { await home.click(); await expect(tagline).toHaveText(brandPhrase); }
  finally { await page.evaluate(() => window.qaRestoreTaglineRandom?.()); }
  await played('/sounds/gameover.mp3', brandPrior);
  evidence.checks.specialPhraseUsesOwnSound = { phrase: brandPhrase, nativePlaying: true };
  await home.click();
  await expect(tagline).not.toHaveText(brandPhrase);
  await page.waitForFunction(() => document.getElementById("header-tagline-typed").textContent === document.getElementById("header-tagline-label").textContent);
  const typingPlayers = await page.evaluate(() => window.qaMenuAudio.media.filter(audio => audio.src.endsWith("type.mp3")).length);
  assert.equal(typingPlayers, 0, "Ordinary sentences finish typing without loading a sound");
  evidence.checks.silentPrinting = { typingPlayers };
  assert.ok((await page.evaluate(() => window.qaMenuAudio.calls.filter(row => !row.source.endsWith("gameover.mp3"))))
    .every(row => ["pointerenter", "pointerover", "click"].includes(row.event)), "Button playback attempts occur in their input event");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, "header-menu-audio.png") });
  assert.deepEqual(await snapshot(), before, "Menu audio preserves the entire initialized calculator, pricing and project draft");
  evidence.checks.draftsPreserved = true;
  evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio.calls, playing: window.qaMenuAudio.playing, csp: window.qaMenuAudio.csp }));
  await noDownloadAudio();
  assert.deepEqual(evidence.audio_events.csp, []); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blocked_requests, []);
  evidence.source_sha256_after = sourceHashes(); assert.deepEqual(evidence.source_sha256_after, evidence.source_sha256);
  evidence.limits = ["Native media playing events and exact decoded assets are verified; physical speaker audibility and hardware latency are not measured.", "The first hover policy result is this fresh browser observation only; browsers may block unactivated audio. Blocked or unloaded button interactions are never queued for later playback.", "Takeoff/modal context routing and concurrent exports use owned lightweight DOM controls; the representative calculator Document export and global Save cancellation use the real application controls. Downloads never load or play the removed loading clip; their ordinary button click remains enabled.", "Only a fresh owned browser context and random-port fixture with a private download destination were used; the live application and existing tabs were untouched."];
  evidence.passed = true; fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, output, port: info.port, firstHover: evidence.checks.firstHoverPolicyObservation }));
})().catch(async error => {
  evidence.failure = String(error.stack || error); evidence.source_sha256_after = sourceHashes();
  if (page) { evidence.audio_events = await page.evaluate(() => ({ calls: window.qaMenuAudio?.calls, playing: window.qaMenuAudio?.playing, pointers: window.qaMenuAudio?.pointers, media: window.qaMenuAudio?.media.map(media => ({ source: media.src, readyState: media.readyState, error: media.error?.message, paused: media.paused })), button: { count: document.querySelectorAll(".app-header nav button").length, disabled: document.querySelector('.app-header nav [data-view="home"]')?.disabled }, csp: window.qaMenuAudio?.csp })).catch(() => null); await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); }
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(output, "server.log"), logs); });
