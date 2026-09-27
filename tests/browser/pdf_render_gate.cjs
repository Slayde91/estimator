const {chromium} = require('@playwright/test');
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'), out=path.join(root,'.runtime','browser-qa');
const policy="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
(async()=>{
  fs.mkdirSync(out,{recursive:true}); const pdf=path.join(out,'gate.pdf');
  execFileSync(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--fixture-only',pdf]);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'static/vendor/pdfjs/manifest.json'))).files;
  const server=http.createServer((req,res)=>{
    let data,type='application/octet-stream';
    if(req.url==='/'){data=Buffer.from('<!doctype html><meta charset="utf-8"><title>Takeoffs PDF rendering gate</title><script type="module" src="/gate.mjs"></script><h1>Strict-CSP PDF rendering gate</h1>');type='text/html';}
    else if(req.url==='/gate.mjs'){data=fs.readFileSync(path.join(__dirname,'pdf_gate.mjs'));type='text/javascript';}
    else if(req.url==='/fixture.pdf'){data=fs.readFileSync(pdf);type='application/pdf';}
    else if(req.url.startsWith('/vendor/pdfjs/')&&manifest[req.url.slice(14)]){data=fs.readFileSync(path.join(root,'static/vendor/pdfjs',req.url.slice(14)));if(/\.m?js$/.test(req.url))type='text/javascript';}
    else {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type,'Content-Security-Policy':policy,'Content-Length':data.length});res.end(data);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1400,height:1000}});
    const messages=[];page.on('console',m=>{if(['warning','error'].includes(m.type()))messages.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.gateResult?.done,{},{timeout:60000});
    const result=await page.evaluate(()=>window.gateResult);result.console=messages;
    fs.writeFileSync(path.join(out,'pdf-render-gate.json'),JSON.stringify(result,null,2));
    await page.screenshot({path:path.join(out,'pdf-render-gate.png'),fullPage:true});
    assert.equal(result.error,undefined);assert.deepEqual(result.violations,[]);assert.equal(result.pages.length,4);
    for(const p of result.pages){assert.ok(p.marked>100,`page ${p.number} blank`);assert.ok(p.coordinateError<1e-9);}
    assert.ok(result.pages[0].textItems>0);assert.equal(result.pages[1].textItems,0);
    assert.equal(result.pages[2].rotation,90);assert.equal(result.pages[2].userUnit,2);
    console.log('PASS: strict CSP, embedded fonts, scan, rotated crop/UserUnit, JPEG2000 fallback and coordinate round trips');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
