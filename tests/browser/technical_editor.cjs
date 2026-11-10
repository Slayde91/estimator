// Real Technical editor controls and persisted overlays against synthetic private data only.
const {chromium,expect}=require('@playwright/test');
const {chooseLibrary}=require('./section_navigation.cjs');
const {cycleTheme}=require('./theme_navigation.cjs');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`technical-editor-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',['-B',path.join(__dirname,'technical_editor_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>{logs+=v;});
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(`Fixture timeout: ${logs}`)),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[],layouts=[],checks=[],requests=[];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
const field=label=>page.locator('.library-technical-form').getByLabel(label,{exact:true});
const picker=key=>page.locator(`[data-technical-editor-dropdown="${key}"]`);
async function openEditor(id){await chooseLibrary(page,'technical');const detail=page.locator('[data-library-detail="technical"]');if(await detail.isVisible())await detail.getByRole('button',{name:'Back to results',exact:true}).click();await page.locator(`[data-library-record="${id}"]`).click();await detail.locator(`[data-library-edit="${id}"]`).click();await expect(page.locator('.library-technical-form')).toBeVisible();}
async function snapshot(){return page.evaluate(()=>({details:window.CeasefireProject.details(),pricing:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot()}));}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1254,height:900},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>{window.__editorCsp??=[];window.__editorCsp.push({directive:e.violatedDirective,blocked:e.blockedURI});}));
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  const before=await snapshot(),source=path.join(info.library,'library.json'),sourceHash=hash(source);
  await openEditor(info.id);
  const keys=['substrate','orientation','type','category','services','frl'];
  for(const key of keys){await expect(picker(key)).not.toHaveAttribute('open','');await expect(page.locator(`select[data-technical-editor-facet="${key}"]`)).toBeHidden();assert.deepEqual((await page.locator(`select[data-technical-editor-facet="${key}"]`).evaluate(e=>[...e.selectedOptions].map(o=>o.value))).sort(),[...info.initial_facets[key]].sort());}
  assert.ok(info.initial_facets.services.includes('Retained legacy QA value'),'Fixture exposes a retained noncanonical value');
  await picker('services').locator('summary').focus();await page.keyboard.press('Enter');await expect(picker('services')).toHaveAttribute('open','');
  const legacy=picker('services').getByRole('checkbox',{name:'Retained legacy QA value',exact:true});await expect(legacy).toBeChecked();await legacy.focus();await page.keyboard.press('Space');await expect(legacy).not.toBeChecked();await page.keyboard.press('Space');await expect(legacy).toBeChecked();
  await page.keyboard.press('Escape');await expect(picker('services')).not.toHaveAttribute('open','');await expect(picker('services').locator('summary')).toBeFocused();
  checks.push('Closed six grouped multivalue pickers retain unknown values and real keyboard checkbox selection');
  await picker('services').locator('summary').click();
  const services=picker('services').getByRole('checkbox');for(let i=0;i<await services.count();i++)if(await services.nth(i).isChecked())await services.nth(i).uncheck();
  await expect(picker('services').locator('summary')).toHaveText('Choose…');await legacy.check();
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('es',false));await expect(picker('services').locator('summary')).toHaveText('Retained legacy QA value');await expect(legacy).toBeChecked();
  const localeMismatches=await page.evaluate(()=>[...document.querySelectorAll('[data-technical-editor-dropdown]')].flatMap(picker=>{
    const key=picker.dataset.technicalEditorDropdown,select=document.querySelector(`[data-technical-editor-facet="${key}"]`),issues=[];
    for(const checkbox of picker.querySelectorAll('input')){const option=[...select.options].find(option=>option.value===checkbox.value),shown=checkbox.parentElement.querySelector('span').textContent;if(shown!==option.textContent)issues.push({key,value:checkbox.value,shown,expected:option.textContent});}
    const groups=[...select.children].filter(node=>node.tagName==='OPTGROUP'),legends=[...picker.querySelectorAll('legend')];groups.forEach((group,i)=>{if(legends[i].textContent!==group.label)issues.push({key,group:true,shown:legends[i].textContent,expected:group.label});});return issues;
  }));fs.writeFileSync(path.join(output,'locale-probe.json'),JSON.stringify(localeMismatches,null,2));assert.deepEqual(localeMismatches,[],'Visible app-owned Type/group labels follow the same locale as their retained native options');
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await expect(picker('services').locator('summary')).toHaveText('Retained legacy QA value');
  for(let i=0;i<await services.count();i++)if(info.initial_facets.services.includes(await services.nth(i).inputValue()))await services.nth(i).check();
  await picker('services').locator('summary').press('Escape');checks.push('Empty-to-selected summary ownership survives public locale refresh without replacing selected values');
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    for(const width of [1254,390,320]){
      await page.setViewportSize({width,height:900});
      const empty=field('Diagrams & Figures'),long=field('Loaded long description');
      assert.equal(await empty.getAttribute('rows'),'1');await expect.poll(()=>empty.evaluate(e=>e.getBoundingClientRect().height<=60&&e.clientHeight>=e.scrollHeight)).toBe(true);
      await expect.poll(()=>long.evaluate(e=>e.clientHeight>=e.scrollHeight)).toBe(true);
      assert.ok((await long.boundingBox()).height>80,'Existing loaded text expands without clipping');
      const save=page.locator('[data-technical-editor-save]');await save.scrollIntoViewIfNeeded();
      assert.equal(await save.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(208, 0, 27)','Save remains red in every theme');
      await picker('substrate').locator('summary').click();await expect(picker('substrate').locator('fieldset')).not.toHaveCount(0);
      const geometry=await picker('substrate').locator('.library-technical-choices').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,overflow:document.documentElement.scrollWidth-innerWidth,scrollable:e.scrollHeight>e.clientHeight};});
      assert.ok(geometry.left>=0&&geometry.right<=width+1&&geometry.overflow<=1,'Dropdown and editor fit viewport');
      await page.screenshot({path:path.join(output,`editor-${theme}-${width}.png`)});layouts.push({theme,width,geometry});
      await picker('substrate').locator('summary').press('Escape');
    }
    await page.locator('.library-technical-form').getByRole('button',{name:'Cancel',exact:true}).click();await cycleTheme(page);await openEditor(info.id);
  }
  await page.setViewportSize({width:390,height:900});
  const text=('New preserved literal text with <markup> & punctuation.\n').repeat(100);
  await field('System Products').fill(text);await expect.poll(()=>field('System Products').evaluate(e=>e.clientHeight>=e.scrollHeight)).toBe(true);
  assert.ok((await field('System Products').boundingBox()).height>500);await field('System Products').fill('Short');await expect.poll(()=>field('System Products').evaluate(e=>e.getBoundingClientRect().height<=60)).toBe(true);await field('System Products').fill(text);
  const reportUrl=field('Report URL (optional)'),originalUrl=await reportUrl.inputValue();await reportUrl.fill('invalid-url');assert.equal(await reportUrl.evaluate(e=>e.checkValidity()),false,'URL validity is retained');
  const url='https://example.test/'+('long-path-'.repeat(45))+'report.pdf';await reportUrl.fill(url);assert.equal(await reportUrl.evaluate(e=>e.checkValidity()),true);assert.ok((await reportUrl.boundingBox()).height>42,'Long URL wraps and expands');
  await reportUrl.fill(originalUrl);
  const expected={};
  for(const key of keys){
    await picker(key).locator('summary').click();const boxes=picker(key).getByRole('checkbox'),count=await boxes.count();
    assert.ok(count>=2,'Each facet exposes multiple canonical/retained choices');let chosen=0;for(let i=0;i<count;i++)if(await boxes.nth(i).isChecked())chosen++;
    for(let i=0;i<count&&chosen<2;i++)if(!await boxes.nth(i).isChecked()){await boxes.nth(i).check();chosen++;}await picker(key).locator('summary').press('Escape');
    expected[key]=await page.locator(`select[data-technical-editor-facet="${key}"]`).evaluate(e=>[...e.selectedOptions].map(o=>o.value));assert.ok(expected[key].length>1);
  }
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/save'))requests.push(JSON.parse(r.postData()));});
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/libraries/technical/${info.id}/save`);
  await page.locator('[data-technical-editor-save]').click();const savedResponse=await saved,savedBody=await savedResponse.json();assert.equal(savedResponse.status(),200,JSON.stringify(savedBody));await expect(page.locator('.library-technical-editor')).toBeHidden();
  const persisted=await page.evaluate(async id=>{const r=await fetch(`/api/libraries/technical/${id}/edit`);if(!r.ok)throw Error('Reopen failed');return r.json();},info.id);
  for(const key of keys)assert.deepEqual(persisted.record.filter_values[key],expected[key]);assert.equal(persisted.record.fields.find(f=>f.label==='System Products').value,text);
  assert.equal(requests.length,1);assert.equal(requests[0].report.url,originalUrl);assert.ok(requests[0].facets.services.includes('Retained legacy QA value'));
  await page.locator('[data-library-detail="technical"]').locator(`[data-library-edit="${info.id}"]`).click();await expect(field('System Products')).toHaveValue(text);
  await expect.poll(()=>field('System Products').evaluate(e=>e.clientHeight>=e.scrollHeight)).toBe(true);
  for(const key of keys){await expect(picker(key)).not.toHaveAttribute('open','');assert.deepEqual(await page.locator(`select[data-technical-editor-facet="${key}"]`).evaluate(e=>[...e.selectedOptions].map(o=>o.value)),expected[key]);}
  checks.push('Actual save/reopen retains multiple canonical and legacy selections, long literal fields and URL');
  assert.equal(hash(source),sourceHash);assert.equal(sourceHash,info.source_sha256);assert.deepEqual(await snapshot(),before);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__editorCsp||[]),[]);
  checks.push('Canonical source bytes, global Project/calculator/pricing drafts and CSP remain unchanged');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,layouts,requests,expected,sourceHash,errors},null,2));console.log(`PASS Technical editor closed grouped multivalue controls, growing text and real persisted roundtrip: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-4000));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,layouts,requests,errors},null,2));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
