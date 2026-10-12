// Current drafts, combined downloads and theme/layout acceptance on a disposable server.
const {chromium, expect} = require('@playwright/test');
const {chooseCalculator} = require('./calculator_actions.cjs');
const {chooseLibrary, chooseTakeoff} = require('./section_navigation.cjs');
const {cycleTheme} = require('./theme_navigation.cjs');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `project-reports-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data', data=>logs+=data);
const ready = new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[], evidence={themes:[],layouts:[],downloads:[]};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function themeColors(selector, token) {return page.locator(selector).first().evaluate((el, token)=>{
  const probe=document.createElement('span');probe.style.color=`var(${token})`;el.append(probe);
  const expected=getComputedStyle(probe).color;probe.remove();return {actual:getComputedStyle(el).backgroundColor,expected};
},token);}
(async()=>{
  const fixture=await ready;assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:900}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${fixture.port}/`,{waitUntil:'networkidle'});await idle();
  for(const [name,label] of [['Steel (spray)','STEEL CALCULATOR'],['Steel (board)','STEEL CALCULATOR'],['Ductwork (spray/wrap)','DUCTWORK CALCULATOR']]){
    await chooseCalculator(page,name);await expect(page.locator('#calculator-title')).toHaveText(name,{timeout:60000});await idle();await expect(page.locator('#calculator-workspace .eyebrow')).toHaveText(label);
  }
  // Seed a single partial board draft through its public input endpoint, then
  // load that saved calculator into a fresh browser. No real project is touched.
  const seeded=await page.request.put(`http://127.0.0.1:${fixture.port}/api/calculators/steel_board/state`,{data:{inputs:{CALCULATOR:{A9:'REPORT-FIXTURE'}}}});assert.equal(seeded.status(),200);
  page.on('dialog',dialog=>dialog.accept());await page.reload({waitUntil:'networkidle'});await idle();
  await page.locator('nav [data-view="estimate"]').click();await page.locator('nav [data-view="estimate"]').press('Escape');
  // Keep the application's complete request path, but save the fixture bytes
  // into this test directory instead of the machine's Downloads folder.
  await page.route('**/api/project/full-*.pdf',async route=>{
    const payload=route.request().postDataJSON();delete payload.download;
    const response=await page.request.post(route.request().url(),{data:payload});
    if(!response.ok()){await route.fulfill({response});return;}
    const filename=route.request().url().split('/').at(-1), target=path.join(output,filename);
    fs.writeFileSync(target,await response.body());evidence.downloads.push({filename,calculators:payload.calculators});
    await route.fulfill({json:{saved:true,path:target,filename,destination:'downloads'}});
  });
  for(const [id, filename] of [['download-full-schedule','full-schedule.pdf'],['download-full-product-summary','full-product-summary.pdf']]){
    await page.locator('[aria-controls="firestopping-document-actions"]').click();
    const done=page.waitForResponse(response=>response.url().endsWith(filename));await page.locator(`#${id}`).click();assert.equal((await done).status(),200);await idle();
    const text=spawnSync(python,['-c',"from pypdf import PdfReader;import sys;r=PdfReader(sys.argv[1]);assert [o.title for o in r.outline]==['Steel board'];print(len(r.pages))",path.join(output,filename)],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(text.status,0,text.stderr);
  }
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    while(await page.locator('html').getAttribute('data-theme')!==theme)await cycleTheme(page);
    for(const kind of ['penetration','technical']){
      await chooseLibrary(page,kind);await idle();const scope=`[data-library-summary="${kind}"]`;
      await expect(page.locator(scope)).toBeVisible();
      for(const [row, token] of [['.library-summary-total','--theme-button'],['.library-summary-related','--theme-soft']]){
        const colors=await themeColors(`${scope} ${row} td`,token);if(theme!=='ceasefire')assert.equal(colors.actual,colors.expected,`${theme} ${kind} ${row}`);
        evidence.themes.push({theme,kind,row,...colors});
      }
    }
    await chooseLibrary(page,'pricing');await idle();const colors=await themeColors('.pricing-availability','--theme-surface');if(theme!=='ceasefire')assert.equal(colors.actual,colors.expected,`${theme} pricing`);
    await page.locator('.pricing-availability').first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`${theme}-pricing.png`)});
  }
  await chooseTakeoff(page,'steel');await idle();
  for(const width of [1440,1146,801,390]){
    await page.setViewportSize({width,height:900});
    const boxes=await page.evaluate(()=>{
      const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      return {viewer:box('.takeoff-viewer'),navigation:box('.takeoff-page-controls'),tools:box('.takeoff-presentation-tools')};
    });
    assert.ok(boxes.tools.right<=boxes.viewer.right+1);assert.ok(boxes.tools.x>=boxes.viewer.x-1);
    if(boxes.viewer.width>500){
      assert.ok(boxes.navigation.right<=boxes.tools.x+1,'Bottom controls do not overlap');
      assert.ok(Math.abs(boxes.navigation.bottom-boxes.tools.bottom)<2,'Bottom controls align');
    }else assert.ok(boxes.navigation.bottom<=boxes.tools.y,'Narrow controls use separate rows without overlap');
    evidence.layouts.push({width,...boxes});await page.locator('.takeoff-viewer-bottom').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`toolbar-${width}.png`)});
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,errors,...evidence},null,2));console.log(`Project report acceptance passed: ${output}`);
})().catch(async error=>{console.error(error);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:false,error:String(error),errors,...evidence},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
