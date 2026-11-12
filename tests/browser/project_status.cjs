const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `project-status-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'project_status_fixture.py'), output], {cwd:root, windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(() => reject(new Error(`Fixture timeout ${logs}`)), 120000);
  server.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(stdout.split('\n')[0])); }
  });
  server.once('error', reject);
  server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code} ${logs}`)); });
});
const errors = [];
async function projects() {
  await page.locator('nav[aria-label="Main navigation"] button[data-view="projects"]').click();
  await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'false');
}
async function idle() {
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready && !window.CeasefireDesktop.status().busy);
}

(async () => {
  const info = await ready;
  assert.notEqual(info.port, 8765);
  browser = await chromium.launch({headless:true, ...(process.env.CEASEFIRE_BROWSER_PATH ? {executablePath:process.env.CEASEFIRE_BROWSER_PATH} : {})});
  page = await browser.newPage({viewport:{width:1575, height:1000}});
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle(); await projects();
  const board=page.locator('#project-list');
  const columns=board.locator('.project-kanban-column');
  await expect(columns).toHaveCount(5);
  assert.deepEqual(await columns.locator('h2').allTextContents(),['New','Quote','Engage','Won','Lost']);
  assert.deepEqual(await columns.locator('.badge').allTextContents(),['2','1','1','1','1']);
  await expect(board.locator('.project-kanban-card')).toHaveCount(6);
  assert.equal(await board.locator('[draggable="true"]').count(),6);
  const first = board.locator('.project-kanban-card').filter({hasText:'Project 1'});
  await expect(first.locator('.project-details-toggle')).toHaveCount(0);
  const load=first.locator('.project-load-button'), actions=first.locator('summary');
  await expect(load).toHaveText('Load');
  await expect(load).toHaveCSS('background-color','rgb(208, 0, 27)');
  await expect(actions).toHaveText('');
  const [loadBox,estimateBox,titleBox,actionsBox]=await Promise.all([load.boundingBox(),first.locator('.project-card-estimate select').boundingBox(),first.locator('.project-title-button').boundingBox(),actions.boundingBox()]);
  assert.ok(estimateBox.x+estimateBox.width<=loadBox.x && Math.abs(loadBox.y+loadBox.height-estimateBox.y-estimateBox.height)<1,'Estimate Load sits immediately right of its dropdown');
  assert.ok(titleBox.x+titleBox.width<=actionsBox.x && Math.abs(titleBox.y-actionsBox.y)<1,'Small action arrow sits in the top-right of the card');
  let fileLoads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects/load')fileLoads++;});
  await actions.click();
  await expect(first.locator('.project-menu-options > button')).toHaveText(['Open','Load','Edit','Delete','Browse files']);
  await expect(first.locator('.project-menu-options > :last-child')).toHaveClass(/project-row-status/);
  await expect(first.locator('.project-menu-options > :last-child')).toContainText('Move to');
  await first.getByRole('button',{name:'Open',exact:true}).click();
  await expect(page.locator('#project-details-pane')).toBeVisible();
  await expect(page.locator('#project-details-actions')).toBeVisible();
  assert.equal(fileLoads,0,'Open reads metadata without loading the project file');
  await page.getByRole('button',{name:'Back to Projects',exact:true}).click();
  await first.locator('.project-title-button').click();
  await expect(page.locator('#project-details-pane')).toBeVisible();
  await expect(page.locator('#project-list-card')).toBeHidden();
  await expect(page.locator('#project-details-target')).toContainText('Project 1');
  await page.getByRole('button',{name:'Back to Projects',exact:true}).click();
  await expect(page.locator('#project-list-card')).toBeVisible();
  await expect(page.locator('#project-details-pane')).toBeHidden();
  await first.dragTo(columns.filter({has:page.locator('h2').filter({hasText:/^Quote$/})}).locator('.project-column-heading'),{sourcePosition:{x:5,y:5}});
  await expect(columns.filter({has:page.locator('h2').filter({hasText:/^Quote$/})}).locator('.project-kanban-card').filter({hasText:'Project 1'})).toHaveCount(1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status,'Quote');
  await first.locator('summary').click();
  await expect(first.getByRole('button',{name:'Open',exact:true})).toBeEnabled();
  await expect(first.getByRole('button',{name:'Edit',exact:true})).toBeDisabled();
  const stage=first.getByRole('combobox',{name:/Status for/});
  await expect(stage.locator('option')).toHaveText(['New','Quote','Engage','Won','Lost']);
  await stage.selectOption('Won');
  await expect(columns.filter({has:page.locator('h2').filter({hasText:/^Won$/})}).locator('.project-kanban-card').filter({hasText:'Project 1'})).toHaveCount(1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status,'Won');
  const searchBox=await page.locator('#project-search').boundingBox();
  const toolbarGeometry=await page.locator('#project-list-card .project-list-controls').evaluate(el=>{const box=node=>node.getBoundingClientRect().toJSON();return{controls:box(el),options:box(el.querySelector('.project-list-options')),sort:box(el.querySelector('#project-sort')),create:box(el.querySelector('#new-quote')),viewport:innerWidth};});
  assert.ok(searchBox.x>=toolbarGeometry.controls.left&&searchBox.x+searchBox.width<=toolbarGeometry.options.left+1&&toolbarGeometry.options.right<=toolbarGeometry.controls.right+1&&toolbarGeometry.controls.left>=0&&toolbarGeometry.controls.right<=toolbarGeometry.viewport+1,'Search and Sort/action group remain bounded: '+JSON.stringify({searchBox,...toolbarGeometry}));
  assert.ok(toolbarGeometry.sort.right<=toolbarGeometry.create.left+1&&Math.abs(toolbarGeometry.sort.bottom-toolbarGeometry.create.bottom)<1,'Sort and New share the same row: '+JSON.stringify(toolbarGeometry));
  await first.locator('summary').click();await first.locator('.project-menu-options').getByRole('button',{name:'Load',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#view-quotes')).toBeVisible();
  await idle();
  await expect(page.locator('#project-name')).toHaveText('Project 1');
  await projects();
  await page.evaluate(()=>localStorage.setItem('classifire.projectColumns','[]'));
  await page.reload(); await idle(); await projects();
  await expect(board.locator('.project-kanban-card')).toHaveCount(6);
  await expect(columns).toHaveCount(5);
  const chooser = page.locator('#project-columns');
  const toggle = chooser.locator('summary');
  const [newBox, columnsBox] = await Promise.all([page.locator('#new-quote').boundingBox(), toggle.boundingBox()]);
  assert.ok(columnsBox.x >= newBox.x + newBox.width && Math.abs(columnsBox.y+columnsBox.height/2-newBox.y-newBox.height/2)<2, 'Columns sits directly right of New');
  await toggle.click();
  await expect(chooser.locator('label')).toHaveText(['New','Quote','Engage','Won','Lost']);
  const won = chooser.getByRole('checkbox', {name:'Won', exact:true});
  await won.uncheck();
  await expect(board.locator('[data-status="Won"]')).toBeHidden();
  await won.press('Escape');
  await expect(toggle).toBeFocused();
  await page.reload(); await idle(); await projects();
  await expect(board.locator('[data-status="Won"]')).toBeHidden();
  await toggle.click();
  await expect(won).not.toBeChecked();
  await won.check();
  await expect(board.locator('[data-status="Won"]')).toContainText('Project 1');
  await page.locator('#project-search').click();
  await expect(won).toBeHidden();
  await page.locator('#project-search').fill('Project 1');
  await expect(board.locator('.project-kanban-card')).toHaveCount(1);
  await page.locator('#project-sort').selectOption('name_asc');
  await expect(board.locator('.project-kanban-card')).toHaveCount(1);
  await first.locator('.project-card-estimate select').selectOption('estimate-1');
  await first.locator('.project-load-button').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#view-estimate')).toBeVisible();
  await idle();
  await expect(page.locator('#project-status')).toHaveCount(0);
  const documentToggle=page.locator('[aria-controls="firestopping-document-actions"]');
  await expect(documentToggle).toBeVisible();
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status,'Won');
  await expect(page.locator('#project-estimate-new')).toHaveAttribute('aria-label','New estimate');
  for(const id of ['project-estimate-new','project-account-new'])await expect(page.locator('#'+id+' .add-symbol')).toHaveText('+');
  for(const width of [320,390,1254,1915]) {
    await page.setViewportSize({width,height:1000});
    const addBox = await page.locator('#project-estimate-new').boundingBox();
    const nameBox = await page.locator('.project-estimate-picker input').boundingBox();
    assert.ok(addBox.x >= nameBox.x && addBox.x - nameBox.x < 10 && addBox.y > nameBox.y &&
      addBox.y + addBox.height < nameBox.y + nameBox.height, 'Add estimate fits inside the left of the picker at ' + width);
    const symbol = await page.locator('#project-estimate-new .button-symbol').evaluate(el=>({size:parseFloat(getComputedStyle(el).fontSize),box:el.getBoundingClientRect().toJSON()}));
    assert.equal(symbol.size,18);
    assert.ok(Math.abs(symbol.box.x+symbol.box.width/2-addBox.x-addBox.width/2)<1);
    assert.ok(Math.abs(symbol.box.y+symbol.box.height/2-addBox.y-addBox.height/2)<1);
  }
  await page.setViewportSize({width:1575,height:1000});
  await projects(); await page.locator('#project-search').fill('');
  await expect(page.locator('.project-list-row')).toHaveCount(6);
  await page.screenshot({path:path.join(output,'projects-list-desktop.png'),fullPage:true});
  for(const width of [1254,390,320]){
    await page.setViewportSize({width,height:844});
    await toggle.click();
    const menuBox = await chooser.locator('.commercial-menu-options').boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width, 'Columns menu fits at ' + width + ': ' + JSON.stringify(menuBox));
    await toggle.press('Escape');
    await first.locator('summary').click();
    await expect.poll(async()=>{
      const menuBounds=await first.locator('.project-menu-options').boundingBox();
      return menuBounds&&menuBounds.x>=0&&menuBounds.y>=0&&menuBounds.x+menuBounds.width<=width&&menuBounds.y+menuBounds.height<=844 ? 'bounded' : JSON.stringify({menuBounds,toggle:await actions.boundingBox(),open:await first.locator('details').getAttribute('open')});
    },{message:'Open card menu fits viewport at '+width}).toBe('bounded');
    const menuContent=await first.locator('.project-menu-options').evaluate(panel=>{
      const label=panel.querySelector('.project-row-status'),select=label.querySelector('select'),range=document.createRange();
      range.selectNodeContents(label.firstChild);
      const bounds=panel.getBoundingClientRect(),style=getComputedStyle(panel);
      return {scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,panel:bounds.toJSON(),contentLeft:bounds.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),contentRight:bounds.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight),select:select.getBoundingClientRect().toJSON(),label:range.getBoundingClientRect().toJSON()};
    });
    assert.ok(menuContent.scrollWidth<=menuContent.clientWidth,'Card menu content has no horizontal overflow at '+width+': '+JSON.stringify(menuContent));
    assert.ok(menuContent.select.left>=menuContent.contentLeft&&menuContent.select.right<=menuContent.contentRight,'Status dropdown fits inside its menu content at '+width);
    assert.ok(menuContent.select.top>=menuContent.label.bottom,'Move to label appears above its dropdown at '+width);
    await page.screenshot({path:path.join(output,`project-menu-${width}.png`)});
    await first.getByRole('combobox',{name:/Status for/}).press('Escape');
    await expect(first.locator('summary')).toBeFocused();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
    if(width===390)await page.screenshot({path:path.join(output,'projects-list-mobile.png'),fullPage:true});
  }
  await page.setViewportSize({width:1575,height:1000});
  const second = page.locator('.project-list-row').filter({hasText:'Project 2'});
  await second.locator('summary').click();
  await second.getByRole('button',{name:'Delete',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.project-list-row')).toHaveCount(5);
  assert.equal(fs.existsSync(path.join(output,'Project-2.cf.json')),false);
  assert.ok(fs.readdirSync(output).some(name=>name.startsWith('.ceasefire-deleted-')));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,toolbarGeometry,checks:['five mapped Project stages retain every record','drag and keyboard status changes persist','Project name and Open open metadata without file load','top-right arrow and bottom status menu','estimate dropdown and Load share a row','menu Load opens project file','mobile card menu is bounded and supports Escape','obsolete column preferences do not hide projects','search and sort','responsive layout','recoverable deletion','no browser errors']}));
})().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);
  if (page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); });
