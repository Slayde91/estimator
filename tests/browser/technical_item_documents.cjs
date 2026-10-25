const { cycleTheme } = require('./theme_navigation.cjs');
// Native Technical Library documents and contrast against disposable evidence only.
const {chromium, expect} = require('@playwright/test');
const {chooseLibrary} = require('./section_navigation.cjs');
const {chooseCalculator} = require('./calculator_actions.cjs');
const {clickProjectControl} = require('./project_actions.cjs');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `technical-item-documents-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python', fixture = path.join(__dirname, 'technical_item_fixture.py');
const server = spawn(python, ['-B', fixture, '--directory', output], {cwd:root, windowsHide:true});
let logs='', browser, page, releaseHeld;
server.stderr.on('data',value=>{logs+=value;});
const ready = new Promise((resolve,reject)=>{
  let data=''; const timer=setTimeout(()=>reject(new Error(`Fixture timeout: ${logs}`)),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${logs}`));});
});
const errors=[], csp=[], layouts=[], scheduleContrast=[], checks=[];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inventory(folder){const result={};for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())for(const [name,value] of Object.entries(inventory(file)))result[`${entry.name}/${name}`]=value;else result[entry.name]=hash(file);}return result;}
function database(file){const child=spawnSync(python,['-B',fixture,'--snapshot-database',file],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);}
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
async function snapshot(){await idle();return page.evaluate(()=>({calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),pricing:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));}
async function contrast(selector){return page.locator(selector).first().evaluate(element=>{
  const rgb=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
  let surface=element;while(surface&&getComputedStyle(surface).backgroundColor==='rgba(0, 0, 0, 0)')surface=surface.parentElement;
  const style=getComputedStyle(element), background=getComputedStyle(surface||document.body).backgroundColor;
  const luminance=value=>rgb(value).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  const a=luminance(style.color),b=luminance(background);return {color:style.color,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
});}
async function exported(extension){
  const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/technical/item.${extension}`);
  await page.locator('.library-document-menu').getByRole('button',{name:'Document',exact:true}).click();
  await page.getByRole('button',{name:`Download Item Details ${extension.toUpperCase()}`,exact:true}).click();
  const reply=await response;assert.equal(reply.status(),200);const body=await reply.json();assert.equal(body.saved,true);
  const relative=path.relative(output,body.path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  assert.equal(fs.readFileSync(body.path).subarray(0,extension==='pdf'?5:2).toString(),extension==='pdf'?'%PDF-':'PK');
  return body.path;
}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:900},reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>{window.__technicalCsp??=[];window.__technicalCsp.push({directive:e.violatedDirective,blocked:e.blockedURI});}));
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  await page.evaluate(()=>window.CeasefirePenetrations.completeProjectSnapshot());
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save-as');
  await clickProjectControl(page,'Save');assert.equal((await saved).status(),200);await idle();
  const projectHash=hash(info.project), libraryBefore=inventory(info.library), databaseBefore=database(info.database), before=await snapshot();
  await chooseLibrary(page,'technical');await page.locator('[data-library-record="report-a-v1"]').click();
  const detail=page.locator('[data-library-detail="technical"]');await expect(detail).toBeVisible();
  const toggle=detail.getByRole('button',{name:'Document',exact:true}), menu=detail.locator('#technical-item-document-actions');
  assert.equal(await toggle.locator('img').getAttribute('src'),'/icons/document.png');
  await toggle.focus();await toggle.press('ArrowDown');await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('End');await expect(menu.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('Home');await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape');await expect(toggle).toBeFocused();await expect(menu).toBeHidden();checks.push('keyboard menu');
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    for(const width of [1146,390]){
      await page.setViewportSize({width,height:900});await toggle.click();await expect(menu.getByRole('button')).toHaveCount(2);
      const geometry=await menu.evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,overflow:document.documentElement.scrollWidth-innerWidth};});
      assert.ok(geometry.left>=0&&geometry.right<=width+1,'Technical Document menu fits viewport');assert.ok(geometry.overflow<=1,'Technical details never overflow viewport');
      await page.screenshot({path:path.join(output,`technical-menu-${theme}-${width}.png`)});
      await detail.locator('h3').click();await expect(menu).toBeHidden();
      await expect(detail.locator('.library-related-record .helper')).toHaveCount(0);
      await expect(detail.locator('.library-record-notice')).toHaveText('Synthetic evidence only; retain every source condition.');
      const values={};for(const selector of ['.library-related-record .library-record-link','.library-record-notice','.library-source span','.library-image figcaption']){
        values[selector]=await contrast(selector);assert.ok(values[selector].ratio>=4.5,`${theme} ${selector} contrast ${values[selector].ratio}`);
      }
      assert.equal(await detail.locator('.library-image img').first().evaluate(e=>getComputedStyle(e).filter),'none','Retained diagram pixels are not theme tinted');
      await detail.locator('.library-related-record').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`technical-source-${theme}-${width}.png`)});
      layouts.push({theme,width,geometry,contrast:values});
    }
    await cycleTheme(page);
  }
  await page.setViewportSize({width:1146,height:900});await toggle.scrollIntoViewIfNeeded();
  const pdf=await exported('pdf'),xlsx=await exported('xlsx');
  const inspection=spawnSync(python,['-B',fixture,'--inspect',pdf,xlsx],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(inspection.status,0,inspection.stderr);const artifacts=JSON.parse(inspection.stdout);checks.push('actual PDF/XLSX contents and hyperlinks');
  let started;const observed=new Promise(resolve=>{started=resolve;});
  await page.route('**/api/technical/item.pdf',async route=>{started(JSON.parse(route.request().postData()));await new Promise(resolve=>{releaseHeld=resolve;});await route.continue();});
  await toggle.click();await menu.getByRole('button').first().click();const captured=await observed;assert.equal(captured.id,'report-a-v1');await expect(toggle).toBeDisabled();
  await detail.getByRole('button',{name:'Back to results',exact:true}).click();await page.locator('[data-library-record="report-a-v2"]').click();
  await expect(detail.locator('h3')).toContainText('report-a-v2');await expect(detail.locator('dd').first()).toHaveText('Separate second item');await expect(toggle).toBeDisabled();
  const completed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/technical/item.pdf');releaseHeld();releaseHeld=null;assert.equal((await completed).status(),200);
  await expect(toggle).toBeEnabled();await expect(page.locator('#technical-library-workspace>.message')).toBeHidden();await page.unroute('**/api/technical/item.pdf');checks.push('held export retains captured id and does not clobber newer item');
  await chooseLibrary(page,'penetration');await page.locator('[data-library-record="pkb-001"]').click();
  const fireDetail=page.locator('[data-library-detail="penetration"]');await expect(fireDetail).toBeVisible();
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    const add=fireDetail.getByRole('button',{name:'Add to Schedule',exact:true});
    await add.scrollIntoViewIfNeeded();const box=await add.boundingBox();assert.equal(box.width,48);assert.equal(box.height,48);
    const colors=await contrast('[data-library-detail="penetration"] .library-add-transfer');assert.ok(colors.ratio>=4.5,`${theme} library schedule control contrast`);
    scheduleContrast.push({theme,control:'library',...colors});
    await page.screenshot({path:path.join(output,`firestopping-library-${theme}.png`)});await cycleTheme(page);
  }
  await chooseCalculator(page,'Firestopping');await expect(page.locator('#penetration-add-to-schedule')).toBeVisible();
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    const add=page.locator('#penetration-add-to-schedule');await add.scrollIntoViewIfNeeded();const box=await add.boundingBox();assert.equal(box.width,48);assert.equal(box.height,48);
    const colors=await contrast('#penetration-add-to-schedule');assert.ok(colors.ratio>=4.5,`${theme} composer schedule control contrast`);
    const source=await contrast('#penetration-diagram-empty');assert.ok(source.ratio>=4.5,`${theme} Source diagram text contrast`);
    scheduleContrast.push({theme,control:'composer',...colors},{theme,control:'source diagram',...source});
    await page.locator('#penetration-diagram').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`firestopping-diagram-${theme}.png`)});
    if(theme==='ceasefire'){
      const settings=page.locator('#penetration-settings');await settings.click();await expect(settings).toHaveAttribute('aria-pressed','true');
      const gear=await contrast('#penetration-settings .gear-symbol');assert.ok(gear.ratio>=4.5,`${theme} active Settings gear contrast ${gear.ratio}`);
      scheduleContrast.push({theme,control:'active Settings gear',...gear});await page.screenshot({path:path.join(output,`firestopping-settings-${theme}.png`)});
      await page.locator('#penetration-input-groups [role="tab"]').first().click();await expect(settings).toHaveAttribute('aria-pressed','false');
    }
    await cycleTheme(page);
  }
  checks.push('five-theme library and composer schedule/source contrast');
  assert.deepEqual(await snapshot(),before,'Exports and menu access preserve calculator/composer/pricing/project drafts');
  assert.equal(hash(info.project),projectHash,'Exports do not rewrite saved project');assert.deepEqual(inventory(info.library),libraryBefore,'Canonical library bytes preserved');assert.deepEqual(database(info.database),databaseBefore,'Read-only documents preserve logical database including preferences');
  csp.push(...await page.evaluate(()=>window.__technicalCsp||[]));assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);checks.push('drafts saved project library and database preserved');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,layouts,scheduleContrast,artifacts,projectHash,libraryBefore,databasePreserved:true,errors,csp},null,2));
  console.log(`PASS Technical Item Details PDF/XLSX, report links/source pixels, guarded native menu and ten responsive layouts; five-theme library/composer contrast and protected fixture state. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-4000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,layouts,errors,csp,error:String(error)},null,2));process.exitCode=1;})
.finally(async()=>{releaseHeld?.();fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
