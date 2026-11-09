const {showEstimateNotes}=require('./estimate_notes.cjs');
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chooseTakeoff} = require('./section_navigation.cjs');
const {renderDrawing} = require('./viewer_helpers.cjs');
const {clickProjectControl,prepareProjectForSave,openProjectSection} = require('./project_actions.cjs');
const root = path.resolve(__dirname,'../..');
const output = path.join(root,'.runtime/browser-qa',`project-estimates-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',chunk=>logs+=chunk);
const ready = new Promise((resolve,reject)=>{
  let data='';const timer=setTimeout(()=>reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});
});
const errors=[];
async function idle(){await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;});}
async function estimate(){await page.locator('#estimate-navigation-toggle').click();await page.locator('#estimate-navigation-toggle').press('Escape');await idle();}
async function save(){const response=page.waitForResponse(r=>/\/api\/project\/save(?:-as)?$/.test(new URL(r.url()).pathname));await clickProjectControl(page,'Save');const reply=await response;assert.equal(reply.status(),200,await reply.text());await idle();return reply.json();}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_PATH?{executablePath:process.env.CEASEFIRE_BROWSER_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();await prepareProjectForSave(page);await estimate();
  await expect(page.locator('#project-no')).toHaveAttribute('readonly','');await showEstimateNotes(page);await page.locator('#measurements').fill('First estimate notes');await page.locator('#measurements').blur();await idle();
  await chooseTakeoff(page,'Steel');await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture),1);await idle();
  const firstSession=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());
  const firstDrawing=await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot().documents[0].id);
  await estimate();await save();
  for(const id of ['project-estimate-create','project-estimate-quote','project-estimate-swms'])await expect(page.locator('#'+id)).toHaveCount(0);
  await page.locator('#project-estimate-new').click();await page.locator('#project-estimate-name').fill('Alternative');
  await page.locator('#project-estimate-dialog').getByRole('button',{name:'Save',exact:true}).click();await idle();
  await expect(page.locator('#project-estimate-select option')).toHaveCount(2);
  const second=await page.locator('#project-estimate-select').inputValue();assert.notEqual(second,'estimate-1');
  await expect(page.locator('#measurements')).toHaveValue('');
  await showEstimateNotes(page);await page.locator('#measurements').fill('Second estimate notes');await page.locator('#measurements').blur();await idle();
  await page.locator('#project-estimate-select').selectOption('estimate-1');await idle();
  await expect(page.locator('#measurements')).toHaveValue('First estimate notes');
  assert.equal(await page.evaluate(()=>window.CeasefireTakeoffs.sessionId()),firstSession);
  assert.equal(await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot().documents[0].id),firstDrawing);
  const nameEditor=page.getByRole('textbox',{name:'Estimate name',exact:true});
  await expect(nameEditor).toHaveValue('Estimate 1');await expect(page.locator('#project-estimate-rename')).toHaveCount(0);
  await nameEditor.scrollIntoViewIfNeeded();
  const hitAreas = await nameEditor.evaluate(input => {
    const box = input.getBoundingClientRect();
    const add = document.getElementById('project-estimate-new').getBoundingClientRect();
    const xPositions = [add.x + add.width / 2, box.x + box.width / 2, box.right - 8];
    return xPositions.map(x => document.elementFromPoint(x, box.y + box.height / 2).closest('button,input,select')?.id);
  });
  assert.deepEqual(hitAreas, ['project-estimate-new', 'project-estimate-current-name', 'project-estimate-select']);
  const plusGeometry=await nameEditor.evaluate(input=>{
    const box=input.getBoundingClientRect(),button=document.getElementById('project-estimate-new'),add=button.getBoundingClientRect(),style=getComputedStyle(button);
    return {left:add.left-box.left,centerDifference:Math.abs(add.top+add.height/2-box.top-box.height/2),background:style.backgroundColor,border:style.borderTopWidth};
  });
  assert.ok(plusGeometry.left>=0 && plusGeometry.left<=5,JSON.stringify(plusGeometry));
  assert.ok(plusGeometry.centerDifference<1,JSON.stringify(plusGeometry));
  assert.equal(plusGeometry.background,'rgba(0, 0, 0, 0)');assert.equal(plusGeometry.border,'0px');
  await nameEditor.press('ArrowDown');await expect(page.locator('#project-estimate-select')).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.locator('#project-estimate-select')).toHaveValue('estimate-1');
  await nameEditor.fill('Discard my typing');await nameEditor.press('Escape');await expect(nameEditor).toHaveValue('Estimate 1');
  await nameEditor.fill('  ');await nameEditor.press('Enter');await expect(nameEditor).toHaveValue('Estimate 1');
  await expect(page.locator('#app-message')).toContainText('between 1 and 150 characters');
  await nameEditor.fill(' Original ');await nameEditor.press('Enter');await idle();
  await expect(nameEditor).toHaveValue('Original');
  await expect(page.locator('#project-estimate-select option[value="estimate-1"]')).toHaveText('Original');
  await page.locator('#project-estimate-select').selectOption(second);await idle();
  await expect(page.locator('#measurements')).toHaveValue('Second estimate notes');await save();
  let saved=JSON.parse(fs.readFileSync(info.project));assert.equal(saved.estimates.length,2);assert.equal(saved.active_estimate_id,second);
  assert.equal(saved.estimates[0].name,'Original');assert.equal(saved.estimates[0].workspace.takeoffs.documents[0].id,firstDrawing);
  await page.reload();await idle();await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  await expect(page.locator('#measurements')).toHaveValue('Second estimate notes');
  await expect(nameEditor).toHaveValue('Alternative');
  await nameEditor.fill('Unsaved name');await expect(page.locator('#project-save-state')).toHaveText('Unsaved changes');
  await nameEditor.press('Escape');await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.locator('#project-estimate-select').selectOption('estimate-1');await idle();
  await expect(page.locator('#measurements')).toHaveValue('First estimate notes');
  await chooseTakeoff(page,'Steel');await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot().documents[0].id),firstDrawing);
  await estimate();await save();
  saved=JSON.parse(fs.readFileSync(info.project));assert.equal(saved.estimates[1].workspace.estimate.measurements,'Second estimate notes');
  await expect(page.locator('#project-status')).toHaveCount(0);
  const documentToggle=page.locator('[aria-controls="firestopping-document-actions"]');
  const quantity=page.locator('#project-input-fields');
  await expect(quantity).toContainText('Sqm/Items',{ignoreCase:true});
  await expect(quantity.locator('+ .calculator-document-menu')).toContainText('Document');
  const controlHeights=[];
  // The quantity follows Estimate and Document follows quantity, including when flex rows wrap.
  for(const width of [1440,881,880,571,570,390]){
    await page.setViewportSize({width,height:1000});await expect(documentToggle).toBeVisible();
    const controls=await documentToggle.evaluate(toggle=>[
      document.querySelector('.project-estimate-picker'),document.querySelector('#project-input-fields input'),toggle
    ].map(element=>element.getBoundingClientRect().toJSON()));
    for(const [i,control] of controls.entries()){
      assert.ok(control.width>0&&control.height>0&&control.left>=0&&control.right<=width,`Visible control at ${width}px: ${JSON.stringify(control)}`);
      if(i===0)continue;
      const previous=controls[i-1],sameRow=Math.abs(control.bottom-previous.bottom)<1;
      assert.ok(sameRow ? control.left>=previous.right : control.top>=previous.bottom,`Ordered, non-overlapping controls at ${width}px: ${JSON.stringify(controls)}`);
      if(width>880)assert.ok(sameRow,`All controls fit the desktop row at ${width}px`);
    }
    if(width===390)assert.ok(controls[2].top>=controls[0].bottom,'Document wraps below the estimate on a phone');
    await documentToggle.click();
    const menu=await page.locator('#firestopping-document-actions').boundingBox();
    assert.ok(menu.x>=0&&menu.x+menu.width<=width,`Estimate Document menu should fit ${width}px: ${JSON.stringify(menu)}`);
    if(width===390)await page.screenshot({path:path.join(output,'estimate-document-menu-mobile.png')});
    await documentToggle.press('Escape');
    controlHeights.push({width,controls,menu});
  }
  fs.writeFileSync(path.join(output,'estimate-control-heights.json'),JSON.stringify(controlHeights,null,2));
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#projects-navigation-toggle').hover();
  await page.locator('#projects-navigation-menu [data-project-section="quotes"]').click();await idle();
  const card=page.locator('.project-list-row').filter({hasText:'PN-01'});
  await expect(card).toHaveCount(1);await expect(card.locator('.project-card-estimate option')).toHaveCount(3);
  const savedBytes=fs.readFileSync(info.project), loadProject=async click=>{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/load');
    await click();await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
    assert.equal((await response).status(),200);await idle();await expect(page.locator('#view-quotes')).toBeVisible();
    await expect(page.locator('#view-estimate')).toBeHidden();await expect(page.locator('#project-browser')).toBeHidden();
    assert.equal((await page.evaluate(()=>window.CeasefireProject.context())).project_path,path.resolve(info.project));
    assert.deepEqual(fs.readFileSync(info.project),savedBytes,'Loading must not rewrite its saved file');
  };
  await loadProject(()=>card.locator('.project-title-button').click());
  await expect(page.locator('#snapshot-message')).toBeHidden();
  await page.locator('#project-current-details').click();await expect(page.locator('#project-details-pane')).toBeVisible();
  await expect(page.locator('#snapshot-message')).toBeVisible();
  assert.equal(await page.locator('#project-pricing-context').textContent(),await page.locator('#header-project-name').textContent());
  await expect(page.locator('#view-estimate #snapshot-message')).toHaveCount(0);
  await card.locator('summary').click();await expect(card.getByRole('button',{name:'Open',exact:true})).toBeEnabled();
  await loadProject(()=>card.getByRole('button',{name:'Open',exact:true}).click());
  await card.locator('.project-card-estimate select').selectOption(second);await expect(page.locator('#view-quotes')).toBeVisible();
  await card.locator('summary').click();await card.getByRole('button',{name:'Open',exact:true}).click();await idle();
  await expect(page.locator('#measurements')).toHaveValue('Second estimate notes');
  assert.equal(await page.locator('#discard-dialog').isVisible(),false);
  await openProjectSection(page,'swms');await page.locator('#swms-root').getByRole('button',{name:'New SWMS',exact:true}).click();
  await expect(page.locator('#swms-root').getByLabel('Job Reference',{exact:true})).toHaveValue('PN-01');
  await page.locator('#swms-root').getByRole('button',{name:'Back to statements'}).click();
  await page.locator('#discard-dialog [value="confirm"]').click();
  await estimate(); await documentToggle.click();await page.locator('#estimate-open-quote').click();
  await expect(page.locator('#view-quote')).toBeVisible();
  await expect(page.locator('#commercial-quote-root').getByLabel('Document title',{exact:true})).toHaveCount(0);
  await expect(page.locator('#commercial-quote-root').getByLabel('Document date',{exact:true})).toBeVisible();
  await expect(page.locator('#commercial-quote-root').getByLabel('Project number',{exact:true})).toHaveValue('PN-01');
  await expect(page.locator('#measurements')).toHaveValue('Second estimate notes');
  await page.screenshot({path:path.join(output,'multiple-estimates.png'),fullPage:true});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,checks:['create','rename','switch keeps notes','inactive takeoff session retained','save all estimates','reload restores inactive drawings','title and unselected Open load the Project in Projects without rewriting its file','selected-Estimate Open retains the selected notes','pricing snapshot notice belongs to the loaded Project in Projects','Document aligns with the estimate row and wraps below on mobile; its menu fits across all breakpoints'],controlHeights}));
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
