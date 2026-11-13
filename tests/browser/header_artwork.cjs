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
async function checkLogoCredit() {
  const phrase = 'Powered by CEASEFIRE PFP', logo = page.getByRole('link', {name:'CLASSIFIRE home'});
  const credit = page.locator('#brand-credit');
  const layout = () => page.evaluate(() => ['.app-header','.brand-logo','#header-tagline','.header-navigation-stack']
    .map(selector => document.querySelector(selector).getBoundingClientRect().toJSON()));
  await expect(logo).toHaveAccessibleDescription(phrase);
  await expect(credit).toHaveAttribute('aria-hidden','true');
  await page.getByRole('button',{name:'Help',exact:true}).click();
  await expect(page.locator('#view-help')).toBeVisible();
  await logo.click();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(credit).toHaveText(phrase);
  const before = await layout();
  await page.evaluate(() => {
    window.logoFrames = [];
    new MutationObserver(() => window.logoFrames.push(document.getElementById('brand-credit').textContent))
      .observe(document.getElementById('brand-credit'),{childList:true});
  });
  // Repeat while holding the completed line. Enter uses the same native home link.
  await logo.focus();
  await page.keyboard.press('Enter');
  await expect(credit).not.toHaveText(phrase);
  await expect(credit).toHaveText(phrase);
  await page.waitForTimeout(550);
  await expect(credit).toHaveText(phrase);
  assert.deepEqual(await layout(),before,'The header geometry is unchanged during the reveal');
  await expect(credit).toBeEmpty({timeout:6000});
  const frames = await page.evaluate(()=>window.logoFrames);
  const completed = frames.indexOf(phrase);
  assert.ok(completed > 1 && frames.slice(0,completed).some(text=>text.startsWith('Powered') && !phrase.startsWith(text)));
  assert.ok(frames.slice(completed+1).some(text=>text.startsWith('Powered') && text.length<phrase.length));
  assert.ok(frames.slice(completed+1).some(text=>text.length>0 && text.length<6),'Reverses to the first few characters');
  assert.deepEqual(await layout(),before);
  await page.emulateMedia({reducedMotion:'reduce'});
  for (const width of [1915,1146,913,390]) {
    await page.setViewportSize({width,height:884});
    const geometry = await layout();
    await page.evaluate(()=>{window.logoFrames.length=0;});
    await logo.click();
    await expect(credit).toHaveText(phrase);
    assert.deepEqual(await layout(),geometry);
    const position = await credit.evaluate(line => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect(), box = line.getBoundingClientRect();
      const logo = document.querySelector('.brand-logo').getBoundingClientRect();
      const character = document.querySelector('#header-tagline-character').getBoundingClientRect();
      return {textCentre:(text.left+text.right)/2, wordmarkCentre:logo.left+logo.width*(446+2133)/(2*2172),
        left:text.left,right:text.right,
        top:box.top,logoInkBottom:logo.top+logo.height*(510/724),characterLeft:character.left};
    });
    assert.ok(position.top>=position.logoInkBottom && position.right<=position.characterLeft,'Credit clears the logo ink and tagline character');
    assert.ok(Math.abs(position.textCentre-position.wordmarkCentre)<1, 'Credit is centred under the word CLASSIFIRE');
    assert.ok(position.left>=0 && position.right<=width, 'The full credit fits in the viewport');
    if (width===913) await page.locator('.app-header').screenshot({path:path.join(output,'centred-credit-913.png')});
    await expect(credit).toBeEmpty();
    assert.ok(await page.evaluate(value=>window.logoFrames.every(frame=>frame===''||frame===value),phrase));
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1146,height:764});
  evidence.push({name:'Logo credit', homeNavigation:true, keyboardReplay:true, reverse:true, reducedMotion:true, stableLayout:true});
}
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
if not logo:
  assert min(corner) < 254, 'An opaque white matte remains'
  border=[im.getpixel((x,y)) for x,y in [(x,0) for x in range(w)]+[(x,h-1) for x in range(w)]+[(0,y) for y in range(h)]+[(w-1,y) for y in range(h)]]
  assert all(max(abs(a-b) for a,b in zip(p,corner))<5 for p in border), 'Filter adds an opaque border outside the image'
if white and not logo:
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
async function checkCreditContrast(theme) {
  const credit = page.locator('#brand-credit');
  await page.getByRole('link',{name:'CLASSIFIRE home'}).click();
  await expect(credit).toHaveText('Powered by CEASEFIRE PFP');
  const color = await credit.evaluate(line=>getComputedStyle(line).color.match(/\d+/g).map(Number));
  const box = await credit.boundingBox();
  const filename = path.join(output,theme+'-logo-credit.png');
  // The last four pixels are backdrop only, so the sample includes the
  // real compositing even for themes with translucent header backgrounds.
  await page.screenshot({path:filename,clip:{x:Math.floor(box.x)-2,y:Math.floor(box.y),
    width:Math.ceil(box.width)+8,height:Math.ceil(box.height)}});
  const sample = spawnSync(python,['-c',`
import json,sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
background = im.getpixel((im.width-2, im.height//2))
foreground = tuple(json.loads(sys.argv[2]))
def luminance(color):
    srgb = [channel/255 for channel in color]
    linear = [x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in srgb]
    return sum(a*b for a,b in zip(linear,(.2126,.7152,.0722)))
lo,hi = sorted([luminance(foreground),luminance(background)])
ratio = (hi+.05)/(lo+.05)
assert ratio >= 4.5, (foreground, background, ratio)
assert sum(sum(abs(a-b) for a,b in zip(pixel,foreground)) < 75 for pixel in im.getdata()) > 20, 'Credit ink missing in screenshot'
print(json.dumps(dict(foreground=foreground,background=background,ratio=round(ratio,2))))
`,filename,JSON.stringify(color)],{encoding:'utf8',windowsHide:true});
  assert.equal(sample.status,0,theme+' '+sample.stderr);
  const reading = {theme,...JSON.parse(sample.stdout),filename};
  if (theme === 'ceasefire') {
    reading.header = path.join(output,'ceasefire-header-full-credit.png');
    await page.getByRole('link',{name:'CLASSIFIRE home'}).click();
    await expect(credit).toHaveText('Powered by CEASEFIRE PFP');
    await page.mouse.move(0,0);
    await page.locator('.app-header').screenshot({path:reading.header});
  }
  evidence.push(reading);
  await expect(credit).toBeEmpty();
}
(async () => {
  const fixture = await ready; assert.notEqual(fixture.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => { window.artworkCsp = []; document.addEventListener('securitypolicyviolation', e => window.artworkCsp.push(e.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${fixture.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await checkLogoCredit();
  for (const theme of ['ceasefire', 'ocean', 'midnight', 'forest', 'slate']) {
    for (let n = 0; n < 5 && await page.locator('html').getAttribute('data-theme') !== theme; n++) await cycleTheme(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.emulateMedia({reducedMotion:'reduce'});
    await checkCreditContrast(theme);
    await page.emulateMedia({reducedMotion:'no-preference'});
    // The existing matte checks require a tinted surface to distinguish
    // transparency from painted white; the Ceasefire header is pure white.
    if (theme === 'ceasefire') continue;
    await page.evaluate(() => window.CeasefireHeaderTaglineMedia.stop());
    await expect(page.locator('.brand-logo')).toHaveAttribute('src','/classifire-logo.png');
    await shot('.brand-logo', theme + '-logo', false, true);
    await shot('#header-tagline-character', theme + '-still', theme === 'midnight');
    await page.evaluate(() => window.CeasefireHeaderTaglineMedia.start());
    await expect(page.locator('#header-tagline-character')).toHaveAttribute('data-tagline-motion', 'playing');
    await page.waitForFunction(() => document.querySelector('#header-tagline-character').complete);
    await shot('#header-tagline-character', theme + '-gif', theme === 'midnight');
  }
  assert.deepEqual(await page.evaluate(() => window.artworkCsp), []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, originals: before, evidence }, null, 2)); console.log('PASS header artwork: ' + output);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(e), evidence }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
