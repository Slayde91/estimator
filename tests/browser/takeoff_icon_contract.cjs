// CSS/icon acceptance on a static, disposable loopback server. No app/API/draft.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), out = path.join(root, '.runtime/browser-qa', `takeoff-icon-contract-${Date.now()}`);
fs.mkdirSync(out, { recursive:true });
const names = ['static/styles.css','static/takeoffs.css','static/theme.css','static/icons/takeoff-visibility.png','static/icons/default-memory.svg','static/icons/signature.svg','tests/browser/takeoff_icon_contract.cjs'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(names.map(name => [name,sha(fs.readFileSync(path.join(root,name)))]));
const before = hashes(), evidence = [], errors = [], requests = [];
const resources = new Map(names.filter(name => name.startsWith('static/')).map(name => ['/' + name.slice(7),fs.readFileSync(path.join(root,name))]));
for (const name of ['Montserrat-Variable.ttf','Montserrat-Italic-Variable.ttf','Vera.ttf','VeraBd.ttf']) resources.set('/fonts/'+name,fs.readFileSync(path.join(root,'static/fonts',name)));
const eye = '<button class="button secondary icon-only takeoff-icon-button takeoff-current-visibility takeoff-visibility-button" aria-label="Visibility"><img src="/icons/takeoff-visibility.png" width="32" height="32" alt=""></button>';
const memory = '<button class="button secondary icon-only takeoff-icon-button takeoff-default-button" aria-label="Set as default"><span class="takeoff-action-icon takeoff-default-icon" aria-hidden="true"></span></button>';
const signature = '<button class="button secondary icon-only takeoff-icon-button takeoff-signature-button" aria-label="Signature"><span class="takeoff-action-icon takeoff-signature-icon" aria-hidden="true"></span></button>';
const actions = `<div class="takeoff-appearance-actions">${memory}${eye}${signature}</div>`;
const html = `<!doctype html><html data-theme="ceasefire"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/takeoffs.css"><link rel="stylesheet" href="/theme.css"><style>body{margin:20px}main{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}.fixture{width:260px;min-height:160px}.fixture h2{font-size:14px}.takeoff-tool-rail{align-items:flex-start;width:58px}.takeoff-physical-details{width:260px;padding:12px;background:#2d2d2d;color:white}h1{font-size:20px}.fixture .takeoff-physical-inspector{background:transparent;border:0;padding:0}.fixture .takeoff-settings-fields{margin-top:12px}</style></head><body><h1>Shared appearance controls</h1><main><section class="fixture"><h2>Drawing rail</h2><div class="takeoff-tool-rail">${eye}${memory}${signature}</div></section><section class="fixture takeoff-markup-settings"><h2>Markup settings</h2><div class="takeoff-settings-fields">${actions}</div></section><section class="fixture takeoff-physical-details"><h2>Physical item settings</h2><aside class="takeoff-physical-inspector"><div class="takeoff-settings-fields">${actions}</div><div class="takeoff-physical-item-actions">${eye}</div></aside></section></main><svg class="takeoff-signature-pad" aria-label="Signature pad" style="max-width:450px;margin-top:20px"><path d="M30 150Q90 30 150 140T290 110" fill="none" stroke="currentColor" stroke-width="3"/></svg></body></html>`;
const server = http.createServer((req,res) => {
  requests.push({ method:req.method,route:req.url });
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405);res.end();return; }
  if (req.url === '/favicon.ico') { res.writeHead(204);res.end();return; }
  const bytes = req.url === '/' ? Buffer.from(html) : resources.get(req.url);
  if (!bytes) { res.writeHead(404);res.end();return; }
  const mime = req.url === '/' ? 'text/html' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.ttf') ? 'font/ttf' : 'image/png';
  res.writeHead(200,{ 'Content-Type':mime,'Content-Length':bytes.length });res.end(req.method === 'HEAD' ? undefined : bytes);
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  assert.notEqual(server.address().port,8765);
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:980,height:550 },deviceScaleFactor:1 });
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => { if(message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed',request => errors.push(request.failure().errorText));
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{ waitUntil:'networkidle' });
  const artwork = await page.evaluate(async () => {
    const inspect = async (src,width,height) => {
      const image = new Image();image.src=src;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,width,height);const data=ctx.getImageData(0,0,width,height).data;
      let opaque=0,transparent=0;for(let i=3;i<data.length;i+=4){if(data[i]>230)opaque++;if(data[i]<10)transparent++;}
      return {data:[...data],opaque,transparent};
    };
    const memory=await inspect('/icons/default-memory.svg',24,24), signature=await inspect('/icons/signature.svg',33,24);
    const alpha=(pixels,x,y,width) => pixels[(y*width+x)*4+3];
    let runs=0,ink=false;for(let x=0;x<33;x++){const next=alpha(signature.data,x,22,33)>10;if(next&&!ink)runs++;ink=next;}
    return {memory:{opaque:memory.opaque,transparent:memory.transparent,arrowHoleAlpha:alpha(memory.data,5,8,24),headAlpha:alpha(memory.data,8,8,24),outerAlpha:alpha(memory.data,23,0,24)},signature:{opaque:signature.opaque,transparent:signature.transparent,baselineDotRuns:runs}};
  });
  assert.ok(artwork.memory.opaque>200);assert.ok(artwork.memory.transparent>100);assert.equal(artwork.memory.outerAlpha,0);assert.equal(artwork.memory.arrowHoleAlpha,0);assert.equal(artwork.memory.headAlpha,255);
  assert.ok(artwork.signature.opaque>20);assert.ok(artwork.signature.transparent>400);assert.equal(artwork.signature.baselineDotRuns,8);
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']) {
    await page.locator('html').evaluate((html,theme) => html.dataset.theme=theme,theme);
    const geometry=await page.locator('button').evaluateAll(buttons => buttons.map(button => {
      const box=button.getBoundingClientRect(),icon=button.querySelector('img,span'),r=icon.getBoundingClientRect(),css=getComputedStyle(icon);
      return {label:button.getAttribute('aria-label'),width:box.width,height:box.height,iconWidth:r.width,iconHeight:r.height,iconFilter:css.filter,iconColor:css.color,maskImage:css.maskImage,iconBackground:css.backgroundColor};
    }));
    for(const control of geometry){assert.equal(control.width,38);assert.equal(control.height,38);assert.equal(control.iconWidth,24);assert.equal(control.iconHeight,24);if(control.label!=='Visibility'){assert.equal(control.iconFilter,'none');assert.ok(control.maskImage.includes(control.label==='Signature'?'signature.svg':'default-memory.svg'));if(theme==='midnight')assert.equal(control.iconBackground,'rgb(255, 255, 255)');}}
    const adjacency=await page.locator('.takeoff-appearance-actions').evaluateAll(rows => rows.map(row => {const buttons=[...row.children].map(el=>el.getBoundingClientRect());return {sameTop:buttons.every(box=>box.top===buttons[0].top),gap:buttons[1].left-buttons[0].right};}));
    for(const row of adjacency){assert.equal(row.sameTop,true);assert.equal(row.gap,8);}
    const pad=await page.locator('.takeoff-signature-pad').evaluate(el => {const css=getComputedStyle(el);return {filter:css.filter,background:css.backgroundColor,color:css.color,touchAction:css.touchAction};});
    assert.equal(pad.filter,'none');assert.equal(pad.background,'rgb(255, 255, 255)');assert.equal(pad.color,'rgb(23, 32, 45)');assert.equal(pad.touchAction,'none');
    const screenshot=path.join(out,theme+'.png');await page.screenshot({path:screenshot});evidence.push({theme,geometry,adjacency,pad,screenshot});
  }
  assert.deepEqual(hashes(),before);assert.equal(errors.length,0);assert.ok(requests.every(request=>['GET','HEAD'].includes(request.method)));
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,assetHashes:before,artwork,evidence,errors,staticFixture:true,browserVersion:browser.version(),port:server.address().port,requests},null,2));
  console.log(JSON.stringify({passed:true,output:out,themes:5,controls:10,browserVersion:browser.version(),errors:0}));
})().catch(error => { fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:String(error.stack||error),assetHashes:before,evidence,errors},null,2));console.error(error);process.exitCode=1; }).finally(async () => { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); });
