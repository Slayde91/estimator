const {cycleTheme}=require('./theme_navigation.cjs');
const {assertPreviewHeaderIcons,views}=require('./preview_header_helpers.cjs');
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),python=process.env.CEASEFIRE_PYTHON||'python';
const output=path.join(root,'.runtime/browser-qa',`navigation-icons-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const assets=[['help','navigation-help.jpg','cbeb2e143619ed7fde0ed7662977852d14e82465fe46d6b07d3d1c8131af2b5b',5000],['takeoffs','navigation-takeoffs.jpg','20ba5328f2968dd61c0df31e4a1678bc538a0d509e30dc42f0425aabd404b08b',1200]];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);});
const evidence=[],errors=[];
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${info.port}/`);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  for(const [name,file,digest,size] of assets){
    assert.equal(hash(fs.readFileSync(path.join(root,'static/icons',file))),digest);
    const reply=await page.request.get(`http://127.0.0.1:${info.port}/icons/${file}`);assert.equal(reply.status(),200);assert.equal(reply.headers()['content-type'],'image/jpeg');assert.equal(hash(await reply.body()),digest);
    await expect(page.locator(`.home-card[data-home-view="${name}"] img`)).toHaveJSProperty('naturalWidth',size);
  }
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await assertPreviewHeaderIcons(page);
    for(const name of views){
      const control=page.locator(`nav [data-view="${name}"]`),image=control.locator('svg');
      await page.locator('nav [data-view="home"]').click();await page.mouse.move(0,0);
      for(const state of ['normal','hover','active','active-hover']){
        if(state==='hover'||state==='active-hover')await control.hover();
        if(state==='active'){await control.click();await control.press('Escape');await page.mouse.move(0,0);await expect(control).toHaveClass(/\bactive\b/);}
        await expect(image).toHaveCSS('stroke-width','2px');
        const appearance=await image.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.closest('button').getBoundingClientRect();return{filter:getComputedStyle(el).filter,blend:getComputedStyle(el).mixBlendMode,width:a.width,height:a.height,centreX:a.x+a.width/2-b.x-b.width/2,centreY:a.y+a.height/2-b.y-b.height/2};});
        assert.equal(appearance.width,26);assert.equal(appearance.height,26);
        assert.ok(Math.abs(appearance.centreX)<.5&&Math.abs(appearance.centreY)<.5,'Header artwork remains centred in its control');
        assert.equal(appearance.filter,'none');assert.equal(appearance.blend,'normal');
        const screenshot=path.join(output,`${theme}-${name}-${state}.png`);await image.screenshot({path:screenshot});
        const pixels=spawnSync(python,['-c',"from PIL import Image; import sys; p=list(Image.open(sys.argv[1]).convert('RGB').getdata()); r=max(sum(v)/3 for v in p)-min(sum(v)/3 for v in p); assert r>100, r",screenshot],{encoding:'utf8',windowsHide:true});assert.equal(pixels.status,0,pixels.stderr);
        evidence.push({theme,name,state,...appearance});
      }
    }
    await page.locator('nav [data-view="home"]').click();await page.mouse.move(0,0);
    await page.screenshot({path:path.join(output,`navigation-${theme}.png`)});await cycleTheme(page);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors,assets},null,2));console.log(`PASS: all eight preview header icons in five themes and four states; original Home artwork retained. ${output}`);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
