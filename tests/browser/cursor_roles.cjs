// Cursor roles on disposable DOM hit targets. No application API or live draft.
const { chromium, expect } = require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`cursor-roles-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const files=['styles.css','calculators.css','libraries.css','takeoffs.css','pdf-cursors.css','pointer-effects.css','pointer-effects.js','laser-reticle.svg'];
const resources=new Map(files.map(name=>['/'+name,fs.readFileSync(path.join(root,'static',name))]));
for(const directory of ['cursors','fonts'])for(const name of fs.readdirSync(path.join(root,'static',directory)))resources.set('/'+directory+'/'+name,fs.readFileSync(path.join(root,'static',directory,name)));
const html=`<!doctype html><html><head><meta charset="utf-8">${files.filter(n=>n.endsWith('.css')).map(n=>`<link rel="stylesheet" href="/${n}">`).join('')}<script src="/pointer-effects.js" defer></script><style>body{margin:16px}.app-header{position:static;display:block;padding:0}nav{display:flex;gap:8px}main{margin:10px 0;padding:0;max-width:none}.roles{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.roles input{width:130px}.roles button{padding:8px}#takeoff-viewport{position:relative;width:600px;height:220px;margin:15px 0}.takeoff-overlay{width:600px;height:220px;position:absolute;inset:0}.takeoff-overlay rect{fill:#eef;stroke:#1264c4;pointer-events:all}dialog{padding:15px}dialog input{width:140px}</style></head><body><header class="app-header"><nav><button id="nav" class="nav-button" data-view="home">Home<svg width="12" height="12"><rect width="10" height="10"/></svg></button><div><button id="nav-choice">Workspace choice</button></div></nav></header><main><h1>Ordinary content</h1><div class="roles"><button id="action">Ordinary action</button><button id="tab" role="tab">Details</button><a id="link" href="#target">Source link</a><input id="text" value="Editable"><input id="readonly" readonly value="Read only"><button id="disabled" disabled>Disabled</button><div class="calculator-tools"><button class="calculator-export-pdf" id="disabled-export" disabled>Disabled export</button></div><div aria-disabled="true"><button id="disabled-child">Unavailable child</button></div></div><label id="library-choice" class="library-link-choice"><input type="checkbox"><span id="library-choice-text">Linked technical record</span></label><label id="library-disabled-choice" class="library-link-choice"><input type="checkbox" disabled><span id="library-disabled-text">Unavailable technical record</span></label><section id="view-takeoffs" hidden></section><div id="takeoff-viewport" class="takeoff-viewport" data-tool="select"><svg class="takeoff-overlay" viewBox="0 0 600 220"><rect id="length" x="20" y="20" width="20" height="20" class="takeoff-control-point" data-cursor-role="move" role="button" aria-label="Translated length point"/><rect id="measure" x="65" y="20" width="20" height="20" data-graphic-part="1" data-cursor-role="move" role="button"/><rect id="polyline" x="110" y="20" width="20" height="20" data-graphic-part="1" data-cursor-role="move"/><rect id="rectangle" x="155" y="20" width="20" height="20" data-graphic-part="2" data-cursor-role="resize-nwse"/><rect id="area" x="200" y="20" width="20" height="20" class="takeoff-control-point" data-cursor-role="resize-nwse" role="button"/><rect id="textbox" x="245" y="20" width="20" height="20" data-graphic-part="2" data-cursor-role="resize-nwse"/><rect id="callout" x="290" y="20" width="20" height="20" class="takeoff-annotation-resize" data-corner="ne"/><rect id="count" x="335" y="20" width="20" height="20" class="takeoff-hit takeoff-count-hit" role="button"/><foreignObject x="20" y="80" width="240" height="65"><div xmlns="http://www.w3.org/1999/xhtml" class="takeoff-control-menu"><button id="point-action">Insert point</button><button id="point-disabled" disabled>Unavailable</button></div></foreignObject></svg><div id="pdf-text-layer" class="takeoff-text-layer" style="left:390px;top:20px;width:180px;height:40px"><span id="pdf-text" style="left:0;top:0;font-size:14px">Sample PDF text</span><br id="pdf-break"></div></div></main><dialog id="dialog"><p>Modal text</p><button id="modal-action">Continue</button><input id="modal-text" value="Edit"><button id="modal-disabled" disabled>Unavailable</button><svg class="takeoff-signature-pad" width="100" height="50"></svg></dialog><div id="popover" popover="manual"><button id="popover-action">Popover action</button><input id="popover-text" value="Edit"><button id="popover-disabled" disabled>Unavailable</button></div></body></html>`;
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const bytes=req.url==='/'?Buffer.from(html):resources.get(req.url);
  if(!bytes){res.writeHead(404);res.end();return;}
  const type=req.url==='/'?'text/html':req.url.endsWith('.css')?'text/css':req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.svg')?'image/svg+xml':req.url.endsWith('.ttf')?'font/ttf':'image/png';
  res.writeHead(200,{'Content-Type':type});res.end(req.method==='HEAD'?undefined:bytes);
});
let browser;const evidence=[],errors=[];
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));assert.notEqual(server.address().port,8765);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:850}});
  page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
  const check=async(selector,role)=>{const target=page.locator(selector);await expect(target).toHaveCSS('cursor',new RegExp(role==='reticle'?'laser-reticle\\.svg':'^'+({pointer:'default',link:'pointer',text:'text',move:'move',grab:'grab',unavailable:'not-allowed',busy:'progress',precision:'crosshair',handwriting:'crosshair','resize-nwse':'nwse-resize','resize-nesw':'nesw-resize'}[role])+'$'));evidence.push({selector,role,cursor:await target.evaluate(el=>getComputedStyle(el).cursor)});};
  for(const selector of ['#nav','#nav svg','#nav-choice'])await check(selector,'reticle');
  for(const selector of ['#action','#tab','#link','#library-choice','#library-choice-text'])await check(selector,'link');
  await check('h1','pointer');await check('#text','text');
  for(const selector of ['#readonly','#disabled','#disabled-export','#disabled-child','#point-disabled','#library-disabled-choice','#library-disabled-text'])await check(selector,'unavailable');
  // Area has point geometry, not a box-resize operation.
  await page.locator('#area').evaluate(el=>el.dataset.cursorRole='move');
  for(const selector of ['#length','#measure','#polyline','#area','#count'])await check(selector,'move');
  for(const selector of ['#rectangle','#textbox'])await check(selector,'resize-nwse');
  await check('#callout','resize-nesw');await check('#point-action','link');
  for(const selector of ['#pdf-text-layer','#pdf-text','#pdf-break'])await check(selector,'pointer');
  for(const id of ['length','measure','polyline','rectangle','area','textbox','callout','count']){
    const box=await page.locator('#'+id).boundingBox();assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.id,[box.x+box.width/2,box.y+box.height/2]),id,'Cursor role belongs to the actual pointer hit target');
  }
  for(const [tool,role] of [['count','precision'],['trace','precision'],['measure','precision'],['graphic-polyline','precision'],['pan','grab'],['text','text'],['signature','handwriting']]){
    await page.locator('#takeoff-viewport').evaluate((el,tool)=>el.dataset.tool=tool,tool);
    for(const selector of ['#takeoff-viewport','#length','#measure','#count','#pdf-text-layer','#pdf-text','#pdf-break'])await check(selector,role);
    if(tool==='text'){const box=await page.locator('#pdf-text').boundingBox();assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.id,[box.x+box.width/2,box.y+box.height/2]),'pdf-text','PDF text cursor belongs to its real hit target');}
  }
  await page.locator('#takeoff-viewport').evaluate(el=>el.dataset.tool='select');
  await page.evaluate(()=>document.querySelector('#dialog').showModal());
  await check('#dialog','pointer');await check('#modal-action','link');await check('#modal-text','text');await check('#modal-disabled','unavailable');await check('.takeoff-signature-pad','handwriting');
  await page.evaluate(()=>document.querySelector('#dialog').close());
  await page.evaluate(()=>document.querySelector('#popover').showPopover());await check('#popover-action','link');await check('#popover-text','text');await check('#popover-disabled','unavailable');
  await page.evaluate(()=>document.documentElement.classList.add('app-busy'));
  for(const selector of ['body','#nav','#disabled','#length','#rectangle','#point-disabled','#popover-action','#popover-disabled','#library-choice-text','#library-disabled-text','#pdf-text'])await check(selector,'busy');
  await page.evaluate(()=>{document.documentElement.classList.remove('app-busy');document.querySelector('#popover').hidePopover();document.querySelector('#view-takeoffs').hidden=false;});
  await page.locator('#action').click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  await page.evaluate(()=>document.querySelector('#dialog').showModal());await page.locator('#modal-action').click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  await page.evaluate(()=>document.querySelector('#dialog').close());
  await page.screenshot({path:path.join(output,'cursor-role-targets.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,semanticHitTargets:8,evidence,errors,port:server.address().port},null,2));console.log(JSON.stringify({passed:true,checks:evidence.length,output}));
})().catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error.stack||error),evidence,errors},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));});
