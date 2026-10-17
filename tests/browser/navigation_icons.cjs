const {cycleTheme}=require('./theme_navigation.cjs');
const {assertPreviewHeaderIcons,views}=require('./preview_header_helpers.cjs');
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),python=process.env.CEASEFIRE_PYTHON||'python';
const output=path.join(root,'.runtime/browser-qa',`navigation-icons-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const assets=[['help','navigation-help.jpg','cbeb2e143619ed7fde0ed7662977852d14e82465fe46d6b07d3d1c8131af2b5b',5000],['takeoffs','navigation-takeoffs.jpg','20ba5328f2968dd61c0df31e4a1678bc538a0d509e30dc42f0425aabd404b08b',1200]];
const homeAreas=[
  ['estimate','Estimates','Build the project material and labour estimates.'],
  ['pricing','Libraries','Manage pricing, firestopping records and technical references.'],
  ['calculators','Calculators','Use the specialist workbook calculators and export schedules.'],
  ['quotes','Projects','Find and reopen project files from your linked folder.'],
  ['takeoffs','Takeoffs','Measure original drawings and keep their source evidence with the project.'],
  ['help','Help','Read the guide to estimates, drawings, schedules and project files.'],
];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);});
const evidence=[],homeEvidence=[],homeActions=[],errors=[],csp=[],saveRequests=[];
async function homeIcons(theme){
  await page.locator('nav [data-view="home"]').click();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-home .home-card')).toHaveCount(homeAreas.length);
  for(const width of [1384,825,390]){
    await page.setViewportSize({width,height:764});
    for(const [view,label,description] of homeAreas){
      const card=page.locator(`.home-card[data-home-view="${view}"]`),svg=card.locator('.home-card-icon svg'),header=page.locator(`nav [data-view="${view}"] svg`);
      await expect(card).toHaveAccessibleName(`${label} ${description}`);
      await expect(card.locator('strong')).toHaveText(label);
      await expect(card.locator(':scope > span:last-child')).toHaveText(description);
      await expect(svg).toHaveCount(1);await expect(card.locator('img')).toHaveCount(0);
      await expect(card.locator('.home-card-icon')).toHaveAttribute('aria-hidden','true');
      await expect(svg).toHaveAttribute('aria-hidden','true');await expect(svg).toHaveAttribute('focusable','false');
      assert.equal(await svg.evaluate(el=>el.outerHTML),await header.evaluate(el=>el.outerHTML),`${view} Home artwork exactly matches its existing header SVG`);
      for(const state of ['normal','hover','focus']){
        await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(0,0);
        await card.click({trial:true});
        if(state==='normal')await page.mouse.move(0,0);
        if(state==='hover')await card.hover();
        if(state==='focus'){await card.focus();await expect(card).toBeFocused();}
        await expect(svg).toHaveCSS('stroke-width','2px');
        const appearance=await svg.evaluate(el=>{const css=getComputedStyle(el),box=el.getBoundingClientRect(),slot=el.parentElement.getBoundingClientRect();return{width:box.width,height:box.height,filter:css.filter,blend:css.mixBlendMode,slotWidth:slot.width,slotHeight:slot.height,centreX:box.x+box.width/2-slot.x-slot.width/2,centreY:box.y+box.height/2-slot.y-slot.height/2,contained:box.x>=slot.x&&box.y>=slot.y&&box.right<=slot.right&&box.bottom<=slot.bottom};});
        assert.ok(Math.abs(appearance.width-26)<.02&&Math.abs(appearance.height-26)<.02,'Home retains the existing26px artwork size');
        assert.equal(appearance.slotWidth,width<=570?42:48);assert.equal(appearance.slotHeight,width<=570?42:48);
        assert.ok(Math.abs(appearance.centreX)<.5&&Math.abs(appearance.centreY)<.5&&appearance.contained,'Home artwork stays centred within its existing card icon slot');
        assert.equal(appearance.filter,'none');assert.equal(appearance.blend,'normal');
        if(state==='normal'){
          const screenshot=path.join(output,`home-${theme}-${view}-${width}.png`);await svg.screenshot({path:screenshot});
          const pixels=spawnSync(python,['-c',"from PIL import Image; import sys; p=list(Image.open(sys.argv[1]).convert('RGB').getdata()); r=max(sum(v)/3 for v in p)-min(sum(v)/3 for v in p); assert r>100, r",screenshot],{encoding:'utf8',windowsHide:true});assert.equal(pixels.status,0,pixels.stderr);
        }
        homeEvidence.push({theme,view,width,state,...appearance});
      }
    }
    await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(0,0);
    await page.screenshot({path:path.join(output,`home-${theme}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1384,height:764});
}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const route=new URL(request.url()).pathname;if(request.method()!=='GET'&&/^\/api\/(?:calculators\/[^/]+\/state|pricing|project\/save(?:-as)?)$/.test(route))saveRequests.push({route,method:request.method()});});
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{window.qaIconCsp??=[];window.qaIconCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI});}));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  for(const [name,file,digest,size] of assets){
    assert.equal(hash(fs.readFileSync(path.join(root,'static/icons',file))),digest);
    const reply=await page.request.get(`http://127.0.0.1:${info.port}/icons/${file}`);assert.equal(reply.status(),200);assert.equal(reply.headers()['content-type'],'image/jpeg');assert.equal(hash(await reply.body()),digest);
    const dimensions=spawnSync(python,['-c',"from PIL import Image; import sys; im=Image.open(sys.argv[1]); assert im.width==int(sys.argv[2]), im.size",path.join(root,'static/icons',file),String(size)],{encoding:'utf8',windowsHide:true});assert.equal(dimensions.status,0,dimensions.stderr);
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
        const appearance=await image.evaluate(el=>{const a=el.getBoundingClientRect(),button=el.closest('button'),b=button.getBoundingClientRect(),label=button.querySelector('.nav-page-label'),c=label.getBoundingClientRect();return{filter:getComputedStyle(el).filter,blend:getComputedStyle(el).mixBlendMode,width:a.width,height:a.height,cssWidth:getComputedStyle(el).width,cssHeight:getComputedStyle(el).height,artSize:getComputedStyle(button).getPropertyValue('--nav-art-size').trim(),zoom:getComputedStyle(button.closest('.header-navigation')).zoom,centreX:a.x+a.width/2-b.x-b.width/2,centreY:a.y+a.height/2-b.y-b.height/2,label:label.textContent,labelVisible:c.width>0&&c.height>0&&getComputedStyle(label).visibility==='visible',labelBelow:c.top>=a.bottom+3.8,labelCentreX:c.x+c.width/2-b.x-b.width/2,contained:a.left>=b.left&&a.top>=b.top&&a.right<=b.right&&c.left>=b.left&&c.right<=b.right&&c.bottom<=b.bottom,stackCentreY:(Math.min(a.top,c.top)+Math.max(a.bottom,c.bottom))/2-b.y-b.height/2};});
        assert.ok(Math.abs(appearance.width-26*(.65*1.2))<.02&&Math.abs(appearance.height-26*(.65*1.2))<.02,'Original 26px artwork renders at the requested20% increase over the previous65% scale');
        assert.equal(appearance.artSize,'26px');assert.equal(appearance.zoom,'0.78');
        assert.ok(appearance.label.trim()&&appearance.labelVisible&&appearance.labelBelow&&appearance.contained,'Each original icon remains above a visible page name within its control');
        assert.ok(Math.abs(appearance.centreX)<.5&&Math.abs(appearance.labelCentreX)<.5&&Math.abs(appearance.stackCentreY)<.5,'The icon and page-name stack remains centred in its control');
        assert.equal(appearance.filter,'none');assert.equal(appearance.blend,'normal');
        const screenshot=path.join(output,`${theme}-${name}-${state}.png`);await image.screenshot({path:screenshot});
        const pixels=spawnSync(python,['-c',"from PIL import Image; import sys; p=list(Image.open(sys.argv[1]).convert('RGB').getdata()); r=max(sum(v)/3 for v in p)-min(sum(v)/3 for v in p); assert r>100, r",screenshot],{encoding:'utf8',windowsHide:true});assert.equal(pixels.status,0,pixels.stderr);
        evidence.push({theme,name,state,...appearance});
      }
    }
    await page.locator('nav [data-view="home"]').click();await page.mouse.move(0,0);
    await page.screenshot({path:path.join(output,`navigation-${theme}.png`)});await homeIcons(theme);await cycleTheme(page);
  }
  for(const [view,label] of homeAreas){
    await page.locator('nav [data-view="home"]').click();const card=page.locator(`.home-card[data-home-view="${view}"]`);
    if(view==='help'){await card.focus();await page.keyboard.press('Enter');}else await card.click();
    await expect(page.locator(`#view-${view}`)).toBeVisible();homeActions.push({view,label,method:view==='help'?'keyboard Enter':'native click'});
  }
  csp.push(...await page.evaluate(()=>window.qaIconCsp||[]));
  assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);assert.deepEqual(saveRequests,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,homeEvidence,homeActions,errors,csp,saveRequests,assets},null,2));console.log(`PASS: all eight header icons and six matching Home icons; five themes, desktop/tablet/mobile and native card actions. ${output}`);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
