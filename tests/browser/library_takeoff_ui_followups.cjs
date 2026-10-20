// Rendered followups use disposable evidence, drawings and project data.
const {chromium,expect}=require('@playwright/test');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseLibrary,chooseTakeoff}=require('./section_navigation.cjs');
const {renderDrawing}=require('./viewer_helpers.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','library-takeoff-ui-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const python=process.env.CEASEFIRE_PYTHON||'python',drawing=path.join(output,'synthetic-drawing.pdf');
execFileSync(python,[path.join(__dirname,'fixtures.py'),'--fixture-only',drawing],{cwd:root,windowsHide:true});
const server=spawn(python,[path.join(__dirname,'technical_item_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{
 let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
 server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});
 server.on('error',reject);server.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+logs));});
});
const errors=[],evidence={tables:[],titles:[],alignment:[],activeTools:[]};
const themes=['ceasefire','midnight','ocean','forest','slate'];
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function setTheme(id){await page.locator('html').evaluate((node,id)=>node.dataset.theme=id,id);}
async function alignment(label){
 const geometry=()=>page.locator('#view-takeoffs').evaluate(root=>{
  const heading=root.querySelector('.takeoff-workspace-heading'),viewport=root.querySelector('#takeoff-viewport'),title=heading.querySelector('h1,h2'),rtl=getComputedStyle(root).direction==='rtl';
  const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const h=box(heading),v=box(viewport),t=box(title),art=[...heading.querySelectorAll('.takeoff-heading-art')].find(node=>getComputedStyle(node).display!=='none');
  return{heading:h,viewport:v,title:t,rtl,delta:rtl?h.right-v.right:h.x-v.x,art:art?box(art):null,overflow:document.documentElement.scrollWidth-innerWidth};
 });
 await expect.poll(async()=>Math.abs((await geometry()).delta),{message:'Takeoffs heading aligns with drawing: '+label}).toBeLessThan(1);
 const value=await geometry();assert.ok(value.overflow<=1,'No viewport overflow at '+label+': '+JSON.stringify(value));
 assert.ok(Math.abs(value.rtl?value.title.right-value.heading.right:value.title.x-value.heading.x)<1,'Title starts at its aligned heading edge: '+label);
 if(value.art)assert.ok(value.rtl?value.art.right<=value.title.x+1:value.art.x>=value.title.right-1,'Existing artwork remains beside the title: '+label);
 evidence.alignment.push({label,...value});
}
async function activePaint(label){
 const active=page.locator('#takeoffs-workspace button:is(.active,.takeoff-tool-active,[aria-pressed=true],[aria-selected=true],[aria-expanded=true])').filter({visible:true});
 for(const button of await active.all())await expect(button).toHaveCSS('border-color','rgb(255, 224, 102)');
 const values=await active.evaluateAll(nodes=>nodes.map(node=>{
  const s=getComputedStyle(node);return{name:node.getAttribute('aria-label')||node.title||node.textContent.trim(),border:s.borderColor,shadow:s.boxShadow,outline:s.outlineColor,outlineStyle:s.outlineStyle};
 }));
 assert.ok(values.length,'Active tools exist: '+label);
 for(const value of values){assert.equal(value.border,'rgb(255, 224, 102)',JSON.stringify(value));assert.match(value.shadow,/255, 224, 102/);if(value.outlineStyle!=='none')assert.equal(value.outline,'rgb(255, 224, 102)',JSON.stringify(value));}
 evidence.activeTools.push({label,values});
}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:900}});page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+info.port+'/');await idle();
 await chooseLibrary(page,'technical');await page.locator('[data-library-record="report-a-v1"]').click();
 const table=page.locator('[data-library-detail="technical"] .library-field-table').first();await expect(table).toBeVisible();
 const sourceText=await table.textContent();
 for(const theme of themes){
  await setTheme(theme);
  const colors=await table.evaluate(table=>{
   const probe=document.createElement('span');probe.style.cssText='background:var(--paper);color:var(--ink);border-color:var(--line)';document.body.append(probe);
   const p=getComputedStyle(probe),expected={background:p.backgroundColor,color:p.color,border:p.borderColor};probe.style.background='var(--theme-soft,var(--paper))';expected.heading=getComputedStyle(probe).backgroundColor;probe.remove();
   const colors=node=>{const s=getComputedStyle(node);return{background:s.backgroundColor,color:s.color,border:s.borderColor};};
   return{expected,head:colors(table.querySelector('th')),body:colors(table.querySelector('td')),table:colors(table)};
  });
  assert.equal(colors.head.background,colors.expected.heading);assert.equal(colors.body.background,colors.expected.background);
  assert.equal(colors.head.color,colors.expected.color);assert.equal(colors.body.color,colors.expected.color);
  assert.equal(colors.body.border,colors.expected.border);assert.equal(await table.textContent(),sourceText,'Theme cannot change source table values');
  evidence.tables.push({theme,colors});await table.screenshot({path:path.join(output,'technical-table-'+theme+'.png')});
 }
 await setTheme('ceasefire');await chooseCalculator(page,'Firestopping');await idle();
 const stripe=await page.locator('#penetration-heading').evaluate(node=>{const s=getComputedStyle(node);return{width:s.borderInlineStartWidth,color:s.borderInlineStartColor,style:s.borderInlineStartStyle};});
 assert.equal(stripe.width,'3px');assert.equal(stripe.style,'solid');
 for(const name of ['Steel (spray)','Steel (board)','Duct']){
  await chooseCalculator(page,name);await idle();const title=page.locator('#calculator-title');await expect(title).toHaveText(name);
  const style=await title.evaluate(node=>{const s=getComputedStyle(node);return{width:s.borderInlineStartWidth,color:s.borderInlineStartColor,style:s.borderInlineStartStyle};});
  assert.deepEqual(style,stripe,'Calculator stripe matches Firestopping: '+name);evidence.titles.push({name,style});
 }
 await chooseCalculator(page,'Firestopping');await idle();await expect(page.locator('.penetration-breakdown-note')).toHaveCount(0);
 for(const width of [1384,1020,825,390]){
  await page.setViewportSize({width,height:900});const actions=page.locator('.penetration-heading-actions'),document=await actions.getByRole('button',{name:'Document',exact:true}).boundingBox(),clear=await actions.locator('#penetration-clear').boundingBox(),library=await actions.locator('#penetration-add-to-library').boundingBox();
  assert.ok(document.x+document.width<=clear.x&&clear.x+clear.width<=library.x,'Document, Clear, Library order at '+width);
  assert.ok(Math.abs(document.y-clear.y)<1&&Math.abs(clear.y-library.y)<1,'First-row alignment at '+width);
 }
 await page.setViewportSize({width:1384,height:900});await chooseLibrary(page,'pricing');await expect(page.locator('#pricing-help')).toHaveCount(0);await expect(page.locator('#pricing-body tr').first()).toBeVisible();
 await chooseTakeoff(page,'Steel');await idle();
 await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(drawing));
 const settings=page.locator('.takeoff-tool-rail').getByRole('button',{name:'Settings',exact:true}),viewports=page.locator('.takeoff-tool-rail').getByRole('button',{name:'Viewport',exact:true});
 for(const width of [1384,825,390]){
  await page.setViewportSize({width,height:900});await alignment(width+'/normal');
  for(const [name,button] of [['settings',settings],['viewports',viewports]]){
   await button.click();await expect(button).toHaveAttribute('aria-expanded','true');await alignment(width+'/'+name);
   const resize=page.locator('.takeoff-pane-resizer');if(await resize.isVisible()){await resize.focus();await resize.press('ArrowRight');await alignment(width+'/'+name+'/resized');}
   await button.click();await expect(button).toHaveAttribute('aria-expanded','false');await alignment(width+'/'+name+'/closed');
  }
 }
 await page.setViewportSize({width:1384,height:900});
 for(const name of ['Steel','Duct','Walls/Floors','Defect Reports','Service Plans']){await chooseTakeoff(page,name);await idle();await alignment('workspace/'+name);}
 await chooseTakeoff(page,'Steel');await idle();
 await page.locator('html').evaluate(node=>node.dir='rtl');await alignment('rtl/normal');await settings.click();await alignment('rtl/settings');await settings.click();await page.locator('html').evaluate(node=>node.removeAttribute('dir'));await alignment('ltr/restored');
 for(const theme of themes){
  await setTheme(theme);await settings.click();await activePaint(theme+'/left-settings');
  const arrow=page.locator('.takeoff-markup-rail').getByRole('button',{name:'Arrow',exact:true});await arrow.click();await activePaint(theme+'/right-arrow');
  const pan=page.locator('.takeoff-page-controls').getByRole('button',{name:'Pan',exact:true});await pan.click();await pan.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(pan).toBeFocused();await activePaint(theme+'/bottom-pan-focused');await settings.click();
 }
 await setTheme('ceasefire');await page.screenshot({path:path.join(output,'takeoff-aligned-yellow-tools.png')});
 assert.deepEqual(errors,[]);evidence.errors=errors;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,syntheticOnly:true,evidence},null,2));console.log('PASS library/Takeoffs UI followups: '+output);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
