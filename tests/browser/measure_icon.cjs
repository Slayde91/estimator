"use strict";
// Exact user-supplied image in every theme; disposable server and browser only.
const {chromium,expect}=require("@playwright/test"),{chooseTakeoff}=require("./section_navigation.cjs");
const {spawn,spawnSync}=require("node:child_process"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const root=path.resolve(__dirname,"../.."),python=process.env.CEASEFIRE_PYTHON||"python",output=path.join(root,".runtime/browser-qa",`measure-icon-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const asset="static/icons/takeoff-measure.avif",expected="0219605c691155ba6d4fc628d3320e61161d7a8263f1b1c546f62e6ec3defc94";
const files=[asset,"static/takeoffs.js","static/takeoffs.css","static/theme.css","estimator/server.py","tests/browser/measure_icon.cjs"],hash=data=>crypto.createHash("sha256").update(data).digest("hex"),hashes=()=>Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),before=hashes();assert.equal(before[asset],expected);
const server=spawn(python,[path.join(__dirname,"fixtures.py"),"--directory",output],{cwd:root,windowsHide:true});let logs="",browser,page;server.stderr.on("data",value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let stdout="";const timer=setTimeout(()=>reject(Error(`Startup timeout: ${logs}`)),120000);server.stdout.on("data",value=>{stdout+=value;if(stdout.includes("\n")){clearTimeout(timer);try{resolve(JSON.parse(stdout.split("\n")[0]));}catch(error){reject(error);}}});server.once("error",error=>{clearTimeout(timer);reject(error);});});
const evidence=[],errors=[];
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:1000},deviceScaleFactor:2});page.setDefaultTimeout(30000);page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);await page.getByRole("button",{name:"Takeoffs",exact:true}).click();await chooseTakeoff(page,"wall");
  const response=await page.request.get(`http://127.0.0.1:${info.port}/icons/takeoff-measure.avif`);assert.equal(response.status(),200);assert.equal(response.headers()["content-type"],"image/avif");assert.equal(hash(await response.body()),expected,"HTTP serves the exact original user image");
  const control=page.getByRole("button",{name:"Measure",exact:true}),image=control.locator("img");await expect(control).toBeVisible();await expect(image).toHaveJSProperty("naturalWidth",626);await expect(image).toHaveJSProperty("naturalHeight",563);
  const fingerprint=await page.evaluate(()=>window.CeasefireTakeoffs.projectFingerprint());
  for(const theme of ["ceasefire","midnight","ocean","forest","slate"]){
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);await control.scrollIntoViewIfNeeded();
    const appearance=await image.evaluate(el=>({src:el.getAttribute("src"),filter:getComputedStyle(el).filter,blend:getComputedStyle(el).mixBlendMode,width:el.naturalWidth,height:el.naturalHeight,buttonBackground:getComputedStyle(el.parentElement).backgroundColor}));
    assert.equal(appearance.filter,theme==="midnight"?"invert(1)":"none");assert.equal(appearance.blend,theme==="midnight"?"screen":"multiply");assert.equal(appearance.src,"/icons/takeoff-measure.avif");
    const file=path.join(output,`measure-${theme}.png`);await image.screenshot({path:file});
    const proof=spawnSync(python,["-B","-c","from PIL import Image; import json,sys; p=list(Image.open(sys.argv[1]).convert('RGB').getdata()); lo=min(sum(v)/3 for v in p); hi=max(sum(v)/3 for v in p); assert hi-lo>100, (lo,hi); print(json.dumps({'minimum':lo,'maximum':hi,'contrast_range':hi-lo}))",file],{encoding:"utf8",windowsHide:true});assert.equal(proof.status,0,proof.stderr);evidence.push({theme,...appearance,pixel_contrast:JSON.parse(proof.stdout),screenshot:file});
    assert.equal(await page.evaluate(()=>window.CeasefireTakeoffs.projectFingerprint()),fingerprint,"Theme/icon checks preserve drawing draft");await page.locator("#theme-toggle").click();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(hashes(),before,"All icon/theme/source bytes remain exact during the native journey");fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,fixture_port:info.port,original_sha256:expected,served_sha256:expected,evidence,errors,source_before:before,source_after:hashes()},null,2));console.log(`PASS: exact Measure original loaded and visibly contrasted in five themes. Evidence: ${output}`);
})().catch(async error=>{console.error(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(output,"failure.png"),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,"failure.json"),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,"server.log"),logs);await browser?.close();server.kill();});
