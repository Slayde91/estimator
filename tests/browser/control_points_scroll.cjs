const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Real keyboard/control-point editing and nested scroll focus on disposable drawings.
const { chromium, expect } = require('@playwright/test');
const { openItemSettings, settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `control-points-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root,windowsHide:true});
let browser, page, logs = '';
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve,reject) => {
  let text=''; const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${logs}`)),120000);
  server.stdout.on('data', chunk => {text+=chunk;if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]));}catch(error){reject(error);}}});
  server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${logs}`));});
});
const errors=[], requests=[], evidence={};
const idle=()=>expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy','true');
async function command(action,op,status=200){const pending=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.op===op);pending.catch(()=>{});await action();const response=await pending,body=await response.json();assert.equal(response.status(),status,JSON.stringify(body));await idle();return body;}
async function renderedPage(action,number,detectScale=false){
  const pending=[page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.op==='record_render'&&r.request().postDataJSON()?.page===number)];
  if(detectScale)pending.push(page.waitForResponse(r=>r.url().endsWith('/auto-calibrate')&&r.request().postDataJSON()?.page===number));
  pending.forEach(value=>value.catch(()=>{}));await action();
  for(const response of await Promise.all(pending)){const body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));}
  await idle();await expect(page.getByLabel('Page number',{exact:true})).toHaveValue(String(number));
  await expect(page.locator('.takeoff-progress')).toHaveText(`synthetic-drawings.pdf · Page ${number} · Original source`);
}
async function dialog(title,values,action){const modal=page.getByRole('dialog');await expect(modal.getByRole('heading',{name:title,exact:true})).toBeVisible({timeout:30000});for(const[label,value]of Object.entries(values)){const field=modal.getByLabel(label,{exact:true});if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));else await field.fill(String(value));}await modal.getByRole('button',{name:action,exact:true}).click();}
const snapshot=async()=>{await idle();let value;await expect.poll(async()=>{try{value=await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());return true;}catch{return false;}}).toBe(true);return value;};
const fit=()=>renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
async function screen([x,y]){
  const overlay=page.locator('.takeoff-overlay');await overlay.scrollIntoViewIfNeeded();
  // Native scrollIntoView does not account for the sticky app header. Keep the
  // fitted plan below it so a source vertex cannot click Home/status instead.
  await page.locator('.takeoff-viewport').evaluate(el=>{const header=document.querySelector('header').getBoundingClientRect();window.scrollBy(0,el.getBoundingClientRect().top-Math.max(0,header.bottom)-12);});
  const box=await overlay.boundingBox(),point=[box.x+(y-30)/540*box.width,box.y+(x-20)/780*box.height];
  assert.equal(await page.evaluate(([cx,cy])=>!!document.elementFromPoint(cx,cy)?.closest('.takeoff-viewport'),point),true,`Source vertex ${x},${y} is outside the visible plan: ${point}`);return point;
}
async function draw(points){for(const point of points)await page.mouse.click(...await screen(point));await page.locator('.takeoff-viewport').press('Enter');}
async function select(ids){const all=page.getByRole('checkbox',{name:'Select all matching items',exact:true});await all.check();await all.uncheck();for(const id of ids)await page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox',{name:/^Select /}).check();}
const handles=id=>page.locator(`.takeoff-control-point[data-control-item-id="${id}"]`);
const handle=(id,index)=>page.locator(`.takeoff-control-point[data-control-item-id="${id}"][data-point-index="${index}"][data-exclusion-id=""]`);
async function planFocus(){await page.getByLabel('Filter register',{exact:true}).focus();await page.locator('.takeoff-viewport').focus();await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-scroll-active','true');}
async function geometryEqual(id,points){assert.deepEqual((await snapshot()).items.find(item=>item.id===id).geometry.points,points);}
async function save(){const pending=page.waitForResponse(r=>r.url().endsWith('/api/project/save-as'));await clickProjectControl(page, 'Save As');assert.equal((await pending).status(),200);await expect(page.locator('#project-save-state')).toHaveText('Saved project');}
async function load(){const pending=page.waitForResponse(r=>r.url().endsWith('/api/project/open'));await clickProjectControl(page, 'Load');assert.equal((await pending).status(),200);await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();await expect(page.locator('#project-save-state')).toHaveText('Saved project');await command(()=>page.getByRole('button',{name:'Takeoffs',exact:true}).click(),'record_render');}
async function scrollState(){return page.locator('.takeoff-viewport').evaluate(el=>({outer:window.scrollY,outerMax:document.documentElement.scrollHeight-innerHeight,top:el.scrollTop,left:el.scrollLeft,height:el.clientHeight,scrollHeight:el.scrollHeight,active:el.dataset.scrollActive,overscroll:getComputedStyle(el).overscrollBehavior}));}
async function wheel(delta){const box=await page.locator('.takeoff-viewport').boundingBox(),point=[box.x+box.width/2,Math.max(120,Math.min(1000,box.y+box.height/2))];evidence.wheelTarget=await page.evaluate(([x,y])=>{const el=document.elementFromPoint(x,y);return{x,y,tag:el?.tagName,insidePlan:!!el?.closest('.takeoff-viewport')};},point);assert.equal(evidence.wheelTarget.insidePlan,true);const count=await page.evaluate(()=>window.qaWheel.length);await page.mouse.move(...point);await page.mouse.wheel(0,delta);await expect.poll(()=>page.evaluate(()=>window.qaWheel.length)).toBeGreaterThan(count);return page.evaluate(()=>window.qaWheel.at(-1));}
(async()=>{
  const info=await ready;browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/commands'))requests.push(request.postDataJSON());});
  await page.addInitScript(()=>{window.qaClicks=[];document.addEventListener('pointerdown',e=>{window.qaClicks.push({tag:e.target.tagName,id:e.target.id,label:e.target.getAttribute('aria-label'),text:e.target.textContent?.slice(0,60),x:e.clientX,y:e.clientY});},true);window.qaCsp=[];document.addEventListener('securitypolicyviolation',e=>window.qaCsp.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
  await page.addInitScript(()=>{window.qaWheel=[];document.addEventListener('wheel',event=>window.qaWheel.push({deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode}),{capture:true});});
  const response=await page.goto(`http://127.0.0.1:${info.port}/`);assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  // Bootstrap finishes its default quote and Home navigation before publishing
  // project controls. Do not race that navigation with this drawing journey.
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  // Upload publishes the document before its initial fit/render has finished.
  // Wait for that page's render and scale inspection before editing the page input.
  await renderedPage(()=>page.locator('#takeoff-upload').setInputFiles(info.fixture),1,true);
  await expect(page.locator('.takeoff-document')).toHaveCount(1);
  await renderedPage(async()=>{await page.getByLabel('Page number',{exact:true}).fill('3');await page.getByLabel('Page number',{exact:true}).press('Tab');},3,true);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  evidence.sourcePageBeforeTracing={page:3,status:await page.locator('.takeoff-progress').innerText()};
  await page.getByRole('button',{name:'Scale',exact:true}).click();await page.getByLabel('Drawing calibration',{exact:true}).selectOption('scale:100');await command(()=>dialog('Apply drawing scale 1:100?',{},'Apply scale'),'add_calibration');
  const shapes=[['CP-PRIMARY',[[100,120],[200,120],[200,220],[300,220]]],['CP-SECONDARY',[[400,350],[500,350],[550,450]]]];
  let state;
  for(const[mark,points]of shapes){await page.getByRole('button',{name:'Trace length',exact:true}).click();await draw(points);state=await command(()=>dialog('Add steel object',{'Member mark':mark,'Level':'L1','Member type':'Beam','Steel section':'100UC15','Product':'CAFCO 300','Fire period (min)':120,'Crit. Temp (\u00b0C)':550,'Exposure':'Re-entrant - 3 sides','Count/QTY':1},'Add item'),'create_item');}
  const a=state.snapshot.items.find(i=>i.fields.mark==='CP-PRIMARY'),b=state.snapshot.items.find(i=>i.fields.mark==='CP-SECONDARY');
  assert.equal(a.geometry.page,3);assert.equal(b.geometry.page,3);
  await select([a.id]);await page.getByRole('button',{name:'Select',exact:true}).click();await handles(a.id).first().scrollIntoViewIfNeeded();await expect(handles(a.id)).toHaveCount(4);await expect(handles(b.id)).toHaveCount(0);
  // Original PDF coordinates determine handle placement even at rotated/cropped/UserUnit2 display scale.
  const centers=await handles(a.id).evaluateAll(nodes=>nodes.map(node=>({index:Number(node.dataset.pointIndex),cx:Number(node.getAttribute('cx')),cy:Number(node.getAttribute('cy'))})));
  const view=await page.locator('.takeoff-overlay').evaluate(el=>({width:Number(el.getAttribute('viewBox').split(/\s+/)[2]),height:Number(el.getAttribute('viewBox').split(/\s+/)[3])}));
  for(const point of centers){const source=a.geometry.points[point.index];assert.ok(Math.abs(point.cx-(source[1]-30)/540*view.width)<1e-7);assert.ok(Math.abs(point.cy-(source[0]-20)/780*view.height)<1e-7);}evidence.controlCoordinates=centers;
  await page.getByRole('button',{name:'Confirm',exact:true}).click();state=await command(()=>dialog('Confirm 1 items?',{},'Confirm items'),'confirm_items');
  const preview=page.waitForResponse(r=>r.url().endsWith('/transfer-preview'));await page.getByRole('button',{name:'Preview transfer',exact:true}).click();assert.equal((await preview).status(),200);
  const applying=page.waitForResponse(r=>r.url().endsWith('/transfer-apply'));await dialog('Transfer 1 confirmed items?',{},'Add to schedule');assert.equal((await applying).status(),200);await idle();
  const calculators=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  await handle(a.id,1).click();await expect(handle(a.id,1)).toHaveAttribute('aria-pressed','true');
  state=await command(()=>page.keyboard.press('Control+z'),'update_item');
  const shortened=a.geometry.points.filter((_,index)=>index!==1),edited=state.snapshot.items.find(item=>item.id===a.id);
  assert.deepEqual(edited.geometry.points,shortened);assert.equal(edited.confirmation,null);assert.equal(state.snapshot.transfers.find(link=>link.item_id===a.id).status,'stale');assert.deepEqual(edited.evidence,a.evidence);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  const expected=shortened.slice(1).reduce((sum,point,index)=>sum+Math.hypot(point[0]-shortened[index][0],point[1]-shortened[index][1]),0)*2*.0254/72*100;
  assert.ok(Math.abs(state.item_results.find(item=>item.id===a.id).length_m-expected)<1e-10);
  state=await command(()=>page.getByRole('button',{name:'Undo last edit',exact:true}).click(),'undo');await geometryEqual(a.id,a.geometry.points);assert.equal(state.snapshot.items.find(item=>item.id===a.id).confirmation,null);
  await select([a.id,b.id]);await handle(a.id,1).click({button:'right'});const menu=page.getByRole('menu');await expect(menu).toBeVisible();state=await command(()=>menu.getByRole('menuitem',{name:'Delete control point',exact:true}).click(),'update_item');
  assert.deepEqual(state.snapshot.items.find(item=>item.id===a.id).geometry.points,shortened);assert.deepEqual(state.snapshot.items.find(item=>item.id===b.id),b);
  await select([a.id,b.id]);await planFocus();const beforeMulti=await snapshot(),countMulti=requests.length;await page.keyboard.press('Control+z');await expect(page.locator('#takeoffs-workspace > .message')).toContainText(/choose|select/i);assert.equal(requests.length,countMulti);assert.deepEqual(await snapshot(),beforeMulti);await expect(page.getByLabel('Page number',{exact:true})).toHaveValue('3');
  await select([a.id]);await planFocus();state=await command(()=>page.keyboard.press('Control+z'),'update_item');assert.equal(state.snapshot.items.find(item=>item.id===a.id).geometry.points.length,2);
  const minimum=await snapshot(),countMin=requests.length;await page.keyboard.press('Control+z');await expect(page.locator('#takeoffs-workspace > .message')).toContainText(/two|2|minimum/i);assert.equal(requests.length,countMin);assert.deepEqual(await snapshot(),minimum);
  await handles(a.id).first().click({button:'right'});await expect(page.getByRole('menu').getByRole('menuitem',{name:'Delete control point',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
  // Native text undo must remain text undo, even with a markup selected.
  const inputPanel=await openItemSettings(page,a.id),level=inputPanel.getByLabel('Level',{exact:true});await level.fill('UNCHANGED-GEOMETRY');const countInput=requests.length;await level.press('Control+z');assert.ok(!requests.slice(countInput).some(request=>request.op==='update_item'),'Native text undo must not delete a geometry point');await level.fill(minimum.items.find(item=>item.id===a.id).fields.level||'');await level.press('Tab');await settingsSettled(page);await geometryEqual(a.id,minimum.items.find(item=>item.id===a.id).geometry.points);await inputPanel.getByRole('button',{name:'Close settings',exact:true}).click();
  // Pending-trace Ctrl+Z removes its last pending point, not a stored item or calculator row.
  await page.getByRole('button',{name:'Trace length',exact:true}).click();await expect(page.locator('.takeoff-control-point')).toHaveCount(0);await fit();for(const point of[minimum.items.find(i=>i.id===a.id).geometry.points[0],[350,130],[400,170]])await page.mouse.click(...await screen(point));await page.locator('.takeoff-viewport').press('Control+z');assert.equal(await page.locator('polyline.takeoff-pending').evaluate(el=>el.points.numberOfItems),2);await page.locator('.takeoff-viewport').press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Add steel object',exact:true})).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await geometryEqual(a.id,minimum.items.find(i=>i.id===a.id).geometry.points);
  await page.getByRole('tab',{name:'WALLS',exact:true}).click();await fit();await page.getByRole('button',{name:'Trace surface',exact:true}).click();await draw([[100,100],[300,100],[300,300],[100,300]]);
  state=await command(()=>dialog('Add wall surface',{'Wall ID':'CP-WALL','Explicit physical quantity':1,'Surface basis':'wall-face','True-surface source citation':'Synthetic true elevation only'},'Add surface'),'create_item');const wall=state.snapshot.items.find(item=>item.fields.mark==='CP-WALL');
  await page.getByRole('button',{name:'Select',exact:true}).click();await handle(wall.id,2).click({button:'right'});state=await command(()=>page.getByRole('menu').getByRole('menuitem',{name:'Delete control point',exact:true}).click(),'update_item');assert.equal(state.snapshot.items.find(item=>item.id===wall.id).geometry.points.length,3);
  await handle(wall.id,0).click({button:'right'});await expect(page.getByRole('menu').getByRole('menuitem',{name:'Delete control point',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Add exclusion',exact:true}).click();await fit();await draw([[130,130],[150,130],[150,150],[130,150]]);state=await command(()=>dialog('Add excluded opening',{'Exclusion source / reason':'Synthetic opening retained identity'},'Add exclusion'),'update_item');const hole=state.snapshot.items.find(item=>item.id===wall.id).geometry.exclusions[0];
  await page.getByRole('button',{name:'Select',exact:true}).click();const holePoint=page.locator(`.takeoff-control-point[data-control-item-id="${wall.id}"][data-exclusion-id="${hole.id}"][data-point-index="1"]`);await holePoint.focus();await expect(holePoint).toHaveAttribute('aria-pressed','true');state=await command(()=>page.keyboard.press('Control+z'),'update_item');const changedHole=state.snapshot.items.find(item=>item.id===wall.id).geometry.exclusions[0];assert.equal(changedHole.id,hole.id);assert.equal(changedHole.note,hole.note);assert.equal(changedHole.points.length,3);
  await page.getByRole('tab',{name:'STEEL',exact:true}).click();
  // Ordinary wheel belongs to the page until the drawing is explicitly focused.
  await page.getByRole('button',{name:'Select',exact:true}).click();await select([a.id]);await fit();for(let i=0;i<5;i++)await renderDrawing(page, () => page.getByRole('button', { name: '+', exact: true }).click());
  await page.locator('.takeoff-viewport').press('Escape');await page.evaluate(()=>window.scrollTo(0,100));await page.locator('.takeoff-viewport').evaluate(el=>{el.scrollTop=80;});let initial=await scrollState();assert.ok(initial.scrollHeight>initial.height+100);await wheel(250);await expect.poll(async()=>(await scrollState()).outer).toBeGreaterThan(initial.outer+100);assert.equal((await scrollState()).top,initial.top);evidence.unfocusedWheel={before:initial,after:await scrollState()};
  // This high-DPI fixture asserts against the actual CSS-pixel event received
  // by JavaScript, rather than assuming it equals the automation input, while
  // retaining the focused-viewer and unchanged outer-page requirements.
  await page.evaluate(()=>window.scrollTo(0,100));await planFocus();initial=await scrollState();const delivered=await wheel(200);assert.equal(delivered.deltaMode,0);assert.ok(delivered.deltaY>0);await expect.poll(async()=>(await scrollState()).top).toBe(initial.top+delivered.deltaY);assert.ok(Math.abs((await scrollState()).outer-initial.outer)<2);evidence.focusedWheel={before:initial,delivered,after:await scrollState()};
  await page.getByRole('heading',{name:'TAKEOFFS',exact:true}).click();await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-scroll-active','false');await page.evaluate(()=>window.scrollTo(0,100));initial=await scrollState();await wheel(180);await expect.poll(async()=>(await scrollState()).outer).toBeGreaterThan(initial.outer+80);assert.equal((await scrollState()).top,initial.top);
  // Clamp to the browser's true maximum, not rounded scrollHeight-clientHeight.
  await page.evaluate(()=>window.scrollTo(0,100));await planFocus();await page.locator('.takeoff-viewport').evaluate(el=>{el.scrollTop=el.scrollHeight;});initial=await scrollState();await page.waitForTimeout(350);await wheel(220);evidence.edgeWheel={before:initial,after:await scrollState()};await expect.poll(async()=>(await scrollState()).outer).toBeGreaterThan(initial.outer+100);assert.equal((await scrollState()).top,initial.top);evidence.edgeWheel.after=await scrollState();
  await page.evaluate(()=>window.scrollTo(0,100));await planFocus();await page.keyboard.press('Escape');await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-scroll-active','false');
  const beforeZoom=await scrollState();await page.keyboard.down('Control');try{await renderDrawing(page,()=>wheel(-120));}finally{await page.keyboard.up('Control');}assert.ok((await scrollState()).scrollHeight>beforeZoom.scrollHeight);await geometryEqual(a.id,minimum.items.find(i=>i.id===a.id).geometry.points);
  await select([b.id]);await page.evaluate(()=>window.scrollTo(0,100));await page.locator('.takeoff-viewport').evaluate((el,id)=>{const point=el.querySelector(`[data-control-item-id="${id}"][data-point-index="1"]`),box=point.getBoundingClientRect(),frame=el.getBoundingClientRect();el.scrollTop+=(box.top+box.height/2)-(frame.bottom-16);},b.id);
  await handle(b.id,1).click({button:'right'});const edgeMenu=page.getByRole('menu');await expect(edgeMenu.getByRole('menuitem',{name:'Delete control point',exact:true})).toBeVisible();const menuBox=await edgeMenu.boundingBox(),frameBox=await page.locator('.takeoff-viewport').boundingBox();assert.ok(menuBox.x>=frameBox.x&&menuBox.y>=frameBox.y&&menuBox.x+menuBox.width<=frameBox.x+frameBox.width+1&&menuBox.y+menuBox.height<=frameBox.y+frameBox.height+1,JSON.stringify({menuBox,frameBox}));await page.screenshot({path:path.join(output,'edge-control-menu.png')});await page.keyboard.press('Escape');
  await page.getByLabel('Filter register',{exact:true}).focus();await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-scroll-active','false');await page.getByRole('button',{name:'Pan',exact:true}).click();await expect(page.locator('.takeoff-control-point')).toHaveCount(0);
  await fit(); for(let i=0;i<4;i++) await renderDrawing(page, () => page.getByRole('button', { name: '−', exact: true }).click());
  await page.locator('.takeoff-viewport').evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-180));
  const panBefore=await snapshot(),panBox=await page.locator('.takeoff-viewport').boundingBox();
  async function freeDrag(dx,dy){
    const before=await page.locator('.takeoff-page').boundingBox(),x=panBox.x+panBox.width/2,y=panBox.y+panBox.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up();
    const after=await page.locator('.takeoff-page').boundingBox();
    assert.ok(Math.abs(after.x-before.x-dx)<2&&Math.abs(after.y-before.y-dy)<2,JSON.stringify({before,after,dx,dy}));return after;
  }
  // Keep dragging on the grey background even after the page leaves the viewport.
  const panSteps=Math.ceil(Math.max(panBox.width/170,panBox.height/90))+2;
  for(let i=0;i<panSteps;i++)await freeDrag(170,90);
  let paper=await page.locator('.takeoff-page').boundingBox();assert.ok(paper.x>panBox.x+panBox.width&&paper.y>panBox.y+panBox.height);
  for(let i=0;i<panSteps*2;i++)await freeDrag(-170,-90);
  paper=await page.locator('.takeoff-page').boundingBox();assert.ok(paper.x+paper.width<panBox.x&&paper.y+paper.height<panBox.y);
  assert.deepEqual(await snapshot(),panBefore,'Panning never edits measurement, scale, evidence or quantity');
  await page.screenshot({path:path.join(output,'paper-outside-viewport.png')});
  await fit();paper=await page.locator('.takeoff-page').boundingBox();
  assert.ok(paper.x>=panBox.x&&paper.y>=panBox.y&&paper.x+paper.width<=panBox.x+panBox.width&&paper.y+paper.height<=panBox.y+panBox.height,'Fit page recovers the paper');
  await geometryEqual(b.id,b.geometry.points);evidence.freePan={allDirections:true,greyBackground:true,fitRecovers:true,geometryUnchanged:true};
  await page.getByRole('button',{name:'Select',exact:true}).click();await select([a.id]);
  await fit();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'selected-control-points.png'),fullPage:true});await page.screenshot({path:path.join(output,'selected-control-points-viewport.png')});await page.locator('.takeoff-viewport').evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-180));await page.screenshot({path:path.join(output,'selected-control-points-plan.png')});
  await save();const saved=JSON.parse(fs.readFileSync(info.project));await load();await select([a.id]);await page.locator(`tr[data-item-id="${a.id}"] .takeoff-row-link`).click();await idle();await geometryEqual(a.id,saved.takeoffs.items.find(i=>i.id===a.id).geometry.points);await expect(handles(a.id)).toHaveCount(2);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);evidence.ids={a:a.id,b:b.id};assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(info.fixture)).digest('hex'),saved.takeoffs.documents[0].sha256);evidence.sourceUnchanged=true;
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,evidence,requests,errors,csp:[]},null,2));console.log(`PASS: selected source-coordinate control points, targeted deletion/minimum/undo, dirty and pending-trace guards, stale linked rows without calculator edits, page/internal/edge wheel focus and save/reopen. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));console.error(JSON.stringify(evidence,null,2));if(page){console.error(JSON.stringify(await page.evaluate(()=>window.qaClicks?.slice(-15)),null,2));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),await page.locator('body').innerText().catch(()=>''));}process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(requests,null,2));if(browser)await browser.close();server.kill();});
