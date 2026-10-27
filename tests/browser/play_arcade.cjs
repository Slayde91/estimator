"use strict";
// Real application and isolated disposable data: games must never save an estimate.
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const output = process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(root, ".runtime/browser-qa", `play-arcade-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const digest = value => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["static/index.html", "static/app.js", "static/games/play.js", "static/games/play.css", "static/games/overspray.js", "static/games/fireline.js", "estimator/server.py"];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
const evidence = { passed: false, source_sha256: sourceHashes(), checks: {}, errors: [], unexpectedWrites: [], csp: [] };
const server = spawn(process.env.CEASEFIRE_PYTHON || "python", [path.join(__dirname, "fixtures.py"), "--directory", output], { cwd: root, windowsHide: true });
let logs = "", browser, page, tracking = false;
server.stderr.on("data", chunk => { logs += chunk; });
const started = new Promise((resolve, reject) => {
  let text = "";
  const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", chunk => {
    text += chunk;
    if (text.includes("\n")) {
      clearTimeout(timer);
      try { resolve(JSON.parse(text.split("\n")[0])); } catch (error) { reject(error); }
    }
  });
  server.once("error", error => { clearTimeout(timer); reject(error); });
  server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const idle = () => page.waitForFunction(() => { const state = window.CeasefireDesktop?.status(); return state?.ready && !state.busy; });
const snapshots = () => page.evaluate(() => ({
  calculators: window.CeasefireCalculators.projectFingerprint(),
  penetration: window.CeasefirePenetrations.projectFingerprint(),
  pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details(),
}));
const storage = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key !== "ceasefire.headerTagline.last" && key !== "classifire.play.v1").sort().map(key => [key, localStorage.getItem(key)])));
const pixels = () => page.locator("#play-canvas").evaluate(canvas => canvas.toDataURL());
const stats = () => page.locator("#play-stats").innerText();
const stat = label => page.locator("#play-stats .play-stat").filter({ has: page.locator("dt", { hasText: label }) }).locator("dd").innerText();
async function openGame(id) {
  await page.locator(`[data-game="${id}"]`).click();
  await expect(page.locator("#play-session")).toBeVisible();
  await expect(page.locator("#play-canvas")).toBeVisible();
  await expect(page.locator("#play-session")).toHaveAttribute("data-game", id);
  await expect(page.locator('#play-actions [data-game-action="start"]')).toBeVisible();
}
async function start() {
  await page.locator('#play-actions [data-game-action="start"]').click();
  await expect(page.locator("#play-session")).toHaveAttribute("data-phase", "playing");
  await expect(page.locator("#play-session")).toHaveAttribute("data-paused", "false");
}
async function canvasPoint(x, y) {
  await page.locator("#play-canvas").scrollIntoViewIfNeeded();
  const bounds = await page.locator("#play-canvas").boundingBox();
  const point = { x: bounds.x + x / 960 * bounds.width, y: bounds.y + y / 600 * bounds.height };
  assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.id, point), "play-canvas", "The aiming point must be on the canvas, clear of sticky headers");
  return point;
}
async function pauseAndCheck() {
  await page.locator("#play-pause").click();
  await expect(page.locator("#play-pause-overlay")).toBeVisible();
  await expect(page.locator("#play-session")).toHaveAttribute("data-paused", "true");
  const before = { stats: await stats(), pixels: await pixels() };
  await page.waitForTimeout(400);
  assert.equal(await stats(), before.stats, "Paused game statistics freeze");
  assert.equal(await pixels(), before.pixels, "Paused game canvas freezes");
  await page.locator("#play-pause-overlay").getByRole("button", { name: /resume/i }).click();
  await expect(page.locator("#play-pause-overlay")).toBeHidden();
  await expect(page.locator("#play-session")).toHaveAttribute("data-paused", "false");
}
async function noHorizontalOverflow() {
  assert.equal(await page.locator("#view-play").evaluate(section => section.scrollWidth <= section.clientWidth + 2), true, "Play section fits the viewport");
  const canvas = await page.locator("#play-canvas").boundingBox();
  assert.ok(canvas.width > 200 && canvas.x >= 0 && canvas.x + canvas.width <= page.viewportSize().width + 1, "Canvas stays inside the narrow viewport");
  assert.ok(Math.abs(canvas.width / canvas.height - 1.6) < 0.015, "Canvas preserves logical aspect ratio");
}
(async () => {
  const info = await started;
  assert.notEqual(info.port, 8765);
  evidence.port = info.port;
  const origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => evidence.errors.push(error.message));
  await page.addInitScript(() => {
    window.qaPlayCsp = [];
    document.addEventListener("securitypolicyviolation", event => window.qaPlayCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    if (tracking && !["GET", "HEAD"].includes(request.method())) {
      evidence.unexpectedWrites.push({ path: new URL(request.url()).pathname, method: request.method() });
      await route.abort(); return;
    }
    await route.continue();
  });
  const response = await page.goto(origin);
  assert.ok(!response.headers()["content-security-policy"].includes("unsafe-inline"));
  await idle();
  await page.evaluate(async () => { await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]); });
  await idle();
  const baseline = await snapshots(), storageBefore = await storage();
  tracking = true;
  await page.locator('.app-header [data-view="settings"]').click();
  await expect(page.locator("#settings-play-button")).toBeVisible();
  await page.locator("#settings-play-button").click();
  await expect(page.locator("#view-play")).toBeVisible();
  await expect(page.locator("#play-hub")).toBeVisible();
  await expect(page.locator("#play-hub [data-game]")).toHaveCount(2);
  await page.screenshot({ path: path.join(output, "game-select.png"), fullPage: true });
  evidence.checks.settingsEntryAndTwoGames = true;

  await openGame("overspray"); await start();
  const initial = await stat("Material left"), point = await canvasPoint(480, 420);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.waitForTimeout(650); await page.mouse.up();
  await expect.poll(() => stat("Material left")).not.toBe(initial);
  await pauseAndCheck();
  await page.screenshot({ path: path.join(output, "overspray.png"), fullPage: true });
  evidence.checks.overspraySpraysAndPauses = true;
  await page.locator('#play-actions [data-game-action="finish"]').click();
  await expect(page.locator("#play-result")).toBeVisible();
  await expect(page.locator("#play-result")).toContainText("Not eligible for a high score");
  const savedScore = await page.evaluate(() => JSON.parse(localStorage.getItem("classifire.play.v1")));
  assert.equal(savedScore.overspray.best, 0, "An under-coated job never earns a high score");
  assert.equal(savedScore.overspray.runs, 1);
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("classifire.play.v1"))), savedScore, "Results are recorded exactly once");
  evidence.checks.scoreQualificationAndSingleRecord = true;
  await page.locator("#play-back").click(); await expect(page.locator("#play-hub")).toBeVisible();
  await expect(page.locator("#play-session")).toBeHidden();

  await openGame("fireline"); await start();
  const fireStart = await pixels();
  await page.locator("#play-canvas").focus();
  await page.keyboard.down("KeyD"); await page.waitForTimeout(300); await page.keyboard.up("KeyD");
  assert.notEqual(await pixels(), fireStart, "FIRELINE movement advances rendered arena");
  const aim = await canvasPoint(700, 400);
  const pressureBefore = parseFloat(await stat("Pressure"));
  await page.mouse.move(aim.x, aim.y); await page.mouse.down();
  await expect.poll(async () => parseFloat(await stat("Pressure"))).toBeLessThan(pressureBefore - 3);
  await page.mouse.up();
  await expect.poll(async () => parseFloat(await stat("Pressure"))).toBe(pressureBefore);
  evidence.checks.firelinePressureConsumptionAndRecovery = true;
  const foamBefore = await page.locator('#play-actions [data-game-action="foam"]').innerText();
  await page.keyboard.press("KeyQ");
  await expect(page.locator('#play-actions [data-game-action="foam"]')).not.toHaveText(foamBefore);
  await page.keyboard.press("Space");
  await expect(page.locator("#play-game-subtitle")).toContainText(/Space dash \(/);
  await pauseAndCheck();
  await page.screenshot({ path: path.join(output, "fireline.png"), fullPage: true });
  evidence.checks.firelineMovementFireAbilitiesAndPause = true;

  // Exercise the window-loss event itself; navigation below is native app input.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("#play-session")).toHaveAttribute("data-paused", "true");
  await expect(page.locator("#play-pause-overlay")).toBeVisible();
  evidence.checks.windowBlurEventPauses = true;
  await page.locator('.app-header [data-view="settings"]').click();
  await expect(page.locator("#view-settings")).toBeVisible();
  await expect(page.locator("#view-play")).toBeHidden();
  const hiddenPixels = await pixels(); await page.waitForTimeout(350);
  assert.equal(await pixels(), hiddenPixels, "Game loop stops while another application section is active");
  const companyName = await page.locator("#company-name").inputValue();
  await page.locator("#company-name").fill("WASD Q E test");
  await expect(page.locator("#company-name")).toHaveValue("WASD Q E test");
  // Company form remains unsaved and is intentionally restored before comparison.
  await page.locator("#company-name").fill(companyName);
  await page.locator("#settings-play-button").click();
  await expect(page.locator("#play-session")).toBeVisible();
  await expect(page.locator("#play-pause-overlay")).toBeVisible();
  await page.locator("#play-back").click();
  await expect(page.locator("#play-hub")).toBeVisible();
  evidence.checks.navigationStopsGameAndReleasesKeyboard = true;

  await page.setViewportSize({ width: 671, height: 850 });
  await openGame("overspray"); await noHorizontalOverflow();
  await page.screenshot({ path: path.join(output, "overspray-narrow.png"), fullPage: true });
  await page.locator("#play-back").click();
  await openGame("fireline"); await noHorizontalOverflow();
  await page.screenshot({ path: path.join(output, "fireline-narrow.png"), fullPage: true });
  await page.locator("#play-back").click();
  evidence.checks.narrowBothGames = true;
  assert.deepEqual(await snapshots(), baseline, "Gameplay and leaving games preserve every estimating/calculator snapshot");
  assert.deepEqual(await storage(), storageBefore, "No unrelated local storage changes");
  assert.deepEqual(evidence.unexpectedWrites, [], "Games issue no API writes");
  evidence.csp = await page.evaluate(() => window.qaPlayCsp);
  assert.deepEqual(evidence.csp, []); assert.deepEqual(evidence.errors, []);
  assert.deepEqual(sourceHashes(), evidence.source_sha256, "Tested production source remains fixed");
  evidence.checks.estimatingStateAndStoragePreserved = true;
  evidence.passed = true;
  console.log(`PASS: Play entry, both games, native pointer/keyboard, pause, exit, narrow layout and estimate isolation. Evidence: ${output}`);
})().catch(async error => {
  evidence.error = error.stack || String(error); console.error(evidence.error);
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(output, "server.log"), logs);
  if (browser) await browser.close(); server.kill();
});
