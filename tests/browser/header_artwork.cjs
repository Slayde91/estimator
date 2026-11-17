const { cycleTheme } = require('./theme_navigation.cjs');
// Render the original artwork under the real CSP on a disposable app only.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `header-artwork-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const python = process.env.CEASEFIRE_PYTHON || 'python';
const originals = ['ceasefire-logo.png', 'classifire-logo.png', 'header-tagline-character.gif', 'header-tagline-character-still.png'];
const hashes = () => Object.fromEntries(originals.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'static', name))).digest('hex')]));
const before = hashes(), server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', v => { logs += v; });
const ready = new Promise((resolve, reject) => {
  let data = ''; const timer = setTimeout(() => reject(Error('Fixture startup timeout')), 120000);
  server.stdout.on('data', v => { data += v; if (data.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(data.split('\n')[0])); } catch (e) { reject(e); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const evidence = [], errors = [];
async function checkHomeLink() {
  const logo = page.getByRole('link', {name:'CLASSIFIRE home'});
  await expect(logo).toHaveAccessibleDescription('');
  await expect(logo.locator('img')).toHaveAttribute('alt','CLASSIFIRE');
  await expect(page.locator('#brand-credit, #brand-credit-description')).toHaveCount(0);
  for (const keyboard of [false, true]) {
    await page.getByRole('button',{name:'Help',exact:true}).click();
    await expect(page.locator('#view-help')).toBeVisible();
    if (keyboard) { await logo.focus(); await page.keyboard.press('Enter'); }
    else await logo.click();
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator('.app-header')).not.toContainText('Powered by CEASEFIRE PFP');
  }
}
async function checkLogoArtwork(name) {
  const filename = path.join(output, name + '.png');
  await page.locator('.brand-logo').screenshot({path:filename});
  const result = spawnSync(python, ['-c', `
from PIL import Image
import json,sys
im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size
corner=im.getpixel((w-1,0))
assert max(abs(a-b) for a,b in zip(corner,im.getpixel((0,0)))) < 5
assert sum(r>170 and g<100 for r,g,b in im.getdata()) > w*h*.05, 'Original brand colors are missing'
print(json.dumps({'size':[w,h],'corner':corner,'passed':True}))
`, filename], { encoding:'utf8', windowsHide:true });
  assert.equal(result.status,0,result.stderr); evidence.push({name,...JSON.parse(result.stdout),filename});
}
(async () => {
  const fixture = await ready; assert.notEqual(fixture.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => { window.artworkCsp = []; document.addEventListener('securitypolicyviolation', e => window.artworkCsp.push(e.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${fixture.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await checkHomeLink();
  for (const theme of ['ceasefire', 'ocean', 'midnight', 'forest', 'slate']) {
    for (let n = 0; n < 5 && await page.locator('html').getAttribute('data-theme') !== theme; n++) await cycleTheme(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The existing matte checks require a tinted surface to distinguish
    // transparency from painted white; the Ceasefire header is pure white.
    if (theme === 'ceasefire') continue;
    await expect(page.locator('.brand-logo')).toHaveAttribute('src','/classifire-logo.png');
    await checkLogoArtwork(theme + '-logo');
  }
  assert.deepEqual(await page.evaluate(() => window.artworkCsp), []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, originals: before, evidence }, null, 2)); console.log('PASS header artwork: ' + output);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(e), evidence }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
