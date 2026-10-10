// Render the original artwork under the real CSP on a disposable app only.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `header-artwork-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const python = process.env.CEASEFIRE_PYTHON || 'python';
const originals = ['ceasefire-logo.png', 'header-tagline-character.gif', 'header-tagline-character-still.png'];
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
async function shot(selector, name, white, logo = false) {
  const filename = path.join(output, name + '.png'), control = page.locator(selector);
  if (logo) await control.screenshot({ path: filename });
  else {
    const b = await control.boundingBox();
    await page.screenshot({ path: filename, clip: { x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4 } });
  }
  // Reading screenshot pixels verifies the rendered result, including SVG
  // filter support and animation compositing, rather than CSS declarations.
  const result = spawnSync(python, ['-c', `
from PIL import Image
import json,sys
im=Image.open(sys.argv[1]).convert('RGB'); pixels=list(im.getdata()); w,h=im.size
white=sys.argv[2]=='true'; logo=sys.argv[3]=='true'
corner=im.getpixel((w-1,0)); end=im.getpixel((0,0) if logo else (w-1,h-1))
assert max(abs(a-b) for a,b in zip(corner,end)) < 5, (corner,end)
assert min(corner) < 254, 'An opaque white matte remains'
if not logo:
  border=[im.getpixel((x,y)) for x,y in [(x,0) for x in range(w)]+[(x,h-1) for x in range(w)]+[(0,y) for y in range(h)]+[(w-1,y) for y in range(h)]]
  assert all(max(abs(a-b) for a,b in zip(p,corner))<5 for p in border), 'Filter adds an opaque border outside the image'
if white:
  ink=[p for p in pixels if min(p)>240]
  assert len(ink)>w*h*.02, 'White foreground is missing'
  assert not any(max(p)-min(p)>65 and max(p)>200 for p in pixels), 'Colored foreground remains in Midnight'
elif logo:
  assert sum(p[0]>170 and p[1]<100 for p in pixels)>w*h*.05, 'Original brand colors are missing'
else:
  assert sum(max(p)<40 for p in pixels)>w*h*.03, 'Original black character is missing'
print(json.dumps({'size':[w,h],'corner':corner,'passed':True}))
`, filename, String(white), String(logo)], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); evidence.push({ name, ...JSON.parse(result.stdout), filename });
}
(async () => {
  const fixture = await ready; assert.notEqual(fixture.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => { window.artworkCsp = []; document.addEventListener('securitypolicyviolation', e => window.artworkCsp.push(e.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${fixture.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  for (const theme of ['ocean', 'midnight', 'forest', 'slate']) {
    for (let n = 0; n < 5 && await page.locator('html').getAttribute('data-theme') !== theme; n++) await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => window.CeasefireHeaderTaglineMedia.stop());
    await shot('.brand-logo', theme + '-logo', theme === 'midnight', true);
    await shot('#header-tagline-character', theme + '-still', theme === 'midnight');
    await page.evaluate(() => window.CeasefireHeaderTaglineMedia.start());
    await expect(page.locator('#header-tagline-character')).toHaveAttribute('data-tagline-motion', 'playing');
    await page.waitForFunction(() => document.querySelector('#header-tagline-character').complete);
    await shot('#header-tagline-character', theme + '-gif', theme === 'midnight');
  }
  assert.deepEqual(await page.evaluate(() => window.artworkCsp), []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, originals: before, evidence }, null, 2)); console.log('PASS header artwork: ' + output);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(e), evidence }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
