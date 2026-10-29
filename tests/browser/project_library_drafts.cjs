const { cycleTheme } = require('./theme_navigation.cjs');
const { chooseLibrary } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Rendered project-only library preservation. Every file, database and dialog
// target is owned by the disposable synthetic fixture below.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), python = process.env.CEASEFIRE_PYTHON || 'python';
const output = path.join(root, '.runtime/browser-qa', `project-library-drafts-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(__dirname, 'project_library_fixture.py');
const server = spawn(python, [fixture, '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {}, exportReadiness = [];
async function captureExportReadiness(phase,kind,scope) {
  const state=await page.evaluate(()=>({pending:window.CeasefireLibraryEditor?.hasPendingOperation(),problem:window.CeasefireLibraryEditor?.inputProblem(),active:{tag:document.activeElement?.tagName,id:document.activeElement?.id},status:document.querySelector('#library-editor-status')?.textContent,message:document.querySelector('#library-editor-message')?.textContent,menu:document.querySelector('#library-editor-document-actions')?.outerHTML,events:window.libraryExportEvents}));
  exportReadiness.push({phase,kind,scope,state,requests:requests.slice(-15)});
  fs.writeFileSync(path.join(output,'export-readiness.json'),JSON.stringify(exportReadiness,null,2));
}
function choose(mode) { fs.writeFileSync(path.join(output, 'dialog-mode.json'), JSON.stringify(mode)); }
function sharedDatabase() {
  const result = spawnSync(python, [fixture, '--snapshot-database', info.database], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Drawing sessions are separate draft state. Include every shared pricing,
  // quote, calculator and library table in this preservation comparison.
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).filter(([name]) => !name.startsWith('takeoff')));
}
async function api(pathname) { const response = await page.request.get(`http://127.0.0.1:${info.port}${pathname}`); assert.equal(response.status(), 200, await response.text()); return response.json(); }
async function reply(action, pathname) {
  const pending = page.waitForResponse(value => new URL(value.url()).pathname === pathname); pending.catch(() => {});
  await action(); const response = await pending, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body;
}
async function load(seed = false) {
  choose({ seed }); await reply(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
}
async function libraryIdle() { await expect.poll(() => page.evaluate(() => window.CeasefireLibraryEditor.hasPendingOperation())).toBe(false); }
async function picture() {
  const image = page.locator('#library-editor-diagram-image');
  await expect(image).toBeVisible(); await expect.poll(() => image.evaluate(value => value.complete && value.naturalWidth > 0)).toBe(true);
  return image.getAttribute('src');
}
async function editorLayout(width, height) {
  await page.setViewportSize({width,height});
  const quantity=page.locator('#library-editor-item-quantity [data-library-editor-field="O"]');
  await expect(quantity).toBeVisible();await expect(page.locator('[data-library-editor-field="O"]')).toHaveCount(1);
  const measured=await page.evaluate(()=>{
    const bounds=selector=>{const box=document.querySelector(selector).getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,bottom:box.bottom};};
    const fields=document.querySelector('#library-editor-fields'),diagram=document.querySelector('.library-editor-diagram');
    return{settings:bounds('#library-editor-settings'),tabs:bounds('#library-editor-groups'),quantity:bounds('#library-editor-item-quantity'),fields:bounds('#library-editor-fields'),diagram:bounds('.library-editor-diagram'),diagramFollowsFields:!!(fields.compareDocumentPosition(diagram)&Node.DOCUMENT_POSITION_FOLLOWING),overflow:document.documentElement.scrollWidth-innerWidth,overflowRegions:[...document.querySelectorAll('#firestopping-library-editor *')].map(element=>({tag:element.tagName,id:element.id,className:element.className,x:element.getBoundingClientRect().x,right:element.getBoundingClientRect().right,width:element.getBoundingClientRect().width})).filter(element=>element.right>innerWidth+1)};
  });
  fs.writeFileSync(path.join(output,`library-editor-layout-${width}.json`),JSON.stringify(measured,null,2));
  assert.ok(Math.abs(measured.settings.y-measured.tabs.y)<1,'Settings aligns with the input tab strip');
  assert.ok(measured.quantity.bottom<=measured.tabs.y,'Item QTY sits above the input tabs');
  assert.ok(measured.diagram.y>=measured.fields.bottom,'Source diagram sits below the active item inputs');
  assert.equal(measured.diagramFollowsFields,true);assert.ok(measured.overflow<=1,`Library editor overflows at ${width}px`);
  await page.locator('#library-editor-input-heading').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`library-editor-layout-${width}.png`),fullPage:true});
  return measured;
}
async function independentDrafts() { return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot() })); }
async function editorSnapshot() { await libraryIdle(); return page.evaluate(()=>({library:window.CeasefireLibraryEditor.projectFingerprint(),dirty:window.CeasefireLibraryEditor.hasUnsavedChanges(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),pricing:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})); }
async function editorExport(kind,scope,configuration,diagram) {
  const before=await editorSnapshot(),savedProject=fs.readFileSync(info.project),database=sharedDatabase(),requestIndex=requests.length;
  await captureExportReadiness('before-menu',kind,scope);
  const toggle=page.locator('[aria-controls="library-editor-document-actions"]'),menu=page.locator('#library-editor-document-actions');
  await toggle.click();await expect(menu.getByRole('button',{name:'Item Details',exact:true})).toHaveCount(2);
  if(scope==='portable-unsaved'&&kind==='pdf') {
    await libraryIdle();
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    const endpoint='**/api/project/library-drafts/prepare';
    let heldCalculations=0;
    await page.route(endpoint,async route=>{
      // A queued debounce calculation may begin after libraryIdle(). Let that
      // request finish; only hold the explicitly triggered native button click.
      const manual=await page.locator('#library-editor-recalculate').getAttribute('data-qa-busy-menu-calculation');
      if(manual==='true'){heldCalculations++;await held;}
      await route.continue();
    });
    try {
      // Invoke the same calculation handler as the debounce timer without a
      // pointer focus change. Check readiness and click in one browser turn so
      // a timer cannot disable the native button between those operations.
      await expect.poll(()=>page.evaluate(()=>{
        const control=document.getElementById('library-editor-recalculate');
        if(control.disabled||window.CeasefireLibraryEditor.hasPendingOperation())return false;
        control.dataset.qaBusyMenuCalculation='true';control.click();return true;
      }),{timeout:60000}).toBe(true);
      await expect.poll(()=>heldCalculations,{timeout:60000}).toBe(1);
      await expect(menu).toBeVisible();await expect(toggle).toBeFocused();
      await expect(page.locator('#library-editor-item-pdf')).toBeDisabled();
    } finally {
      await page.locator('#library-editor-recalculate').evaluate(control=>delete control.dataset.qaBusyMenuCalculation);
      release();await page.unrouteAll({behavior:'wait'});
    }
    await libraryIdle();await expect(menu).toBeVisible();await expect(toggle).toBeFocused();
    evidence.recalculationKeepsDocumentMenuOpen=true;
  }
  await captureExportReadiness('before-click',kind,scope);
  const id=kind==='pdf'?'library-editor-item-pdf':'library-editor-item-excel',pending=page.waitForResponse(reply=>new URL(reply.url()).pathname===`/api/penetration/item.${kind}`&&reply.request().method()==='POST');
  pending.catch(()=>{}); // Preserve the click failure and its diagnostic capture if no request is sent.
  await page.locator(`#${id}`).click();await captureExportReadiness('after-click',kind,scope);const reply=await pending;assert.equal(reply.status(),200,await reply.text());
  const capture=reply.request().postDataJSON(),saved=await reply.json();assert.equal(saved.saved,true);
  assert.deepEqual(capture.configuration,configuration,'Library exports retain their captured prices');assert.deepEqual(capture.diagram,diagram);
  assert.equal(capture.draft,undefined);assert.equal(capture.item.inputs.T,'Project-only edited library item');assert.equal(capture.item.inputs.O,2.125);
  const relative=path.relative(output,saved.path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const target=path.join(output,`${scope}-item.${kind}`),capturePath=path.join(output,`${scope}-item-${kind}-capture.json`);
  fs.copyFileSync(saved.path,target);fs.writeFileSync(capturePath,JSON.stringify(capture,null,2));
  const content=spawnSync(python,[path.join(__dirname,'library_item_export_content.py'),'--capture',capturePath,'--file',target],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(content.status,0,`${content.stdout}\n${content.stderr}`);
  await expect(menu).toBeHidden();await expect(page.locator(`#${id}`)).toHaveAttribute('aria-busy','false');
  assert.deepEqual(await editorSnapshot(),before,'Exports preserve unsaved library/editor, composer, calculator and pricing drafts');
  assert.deepEqual(fs.readFileSync(info.project),savedProject);assert.deepEqual(sharedDatabase(),database);
  assert.equal(requests.slice(requestIndex).some(request=>request.method==='POST'&&/\/(save|refresh-pricing|project-draft)$/.test(request.path)),false);
  (evidence.itemExports ||= []).push({scope,kind,capture,content:JSON.parse(content.stdout),draftsUnchanged:true,sharedDatabaseUnchanged:true,savedProjectUnchanged:true});
}
async function enterLibraries() { await page.getByRole('button', { name: 'Libraries', exact: true }).click(); }
async function openProjectCopy() {
  await enterLibraries(); await chooseLibrary(page, 'penetration');
  const section = page.getByRole('region', { name: 'Project library drafts', exact: true });
  await expect(section).toBeVisible(); await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'project-library-list.png') });
  await section.locator(`[data-project-library-draft="${info.item_id}"]`).click();
  await expect(page.locator('#library-editor-save')).toHaveText('Keep in project draft');
  await expect(page.locator('.library-editor-scope')).toHaveText('These library edits stay within the current project. Use Save to store them in its file.');
  await expect(page.locator('#library-editor-pricing-heading')).toHaveText('Project library price');
}

(async () => {
  info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  await page.addInitScript(() => {
    window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    window.libraryExportEvents=[];
    for(const type of ['pointerdown','mousedown','mouseup','click','focusin','focusout'])document.addEventListener(type,event=>{
      if(!event.target.closest?.('.library-editor-document-menu'))return;
      window.libraryExportEvents.push({type,time:performance.now(),target:event.target.closest('button')?.id,pending:window.CeasefireLibraryEditor?.hasPendingOperation(),menuHidden:document.querySelector('#library-editor-document-actions')?.hidden});
      if(window.libraryExportEvents.length>100)window.libraryExportEvents.shift();
    },true);
  });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  // Bootstrap exposes project tools before the initial Firestopping draft has
  // finished loading. Let it settle before capturing the first Load revision.
  await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; });
  fs.copyFileSync(info.seed, info.project); await load(false);
  const retained = await independentDrafts(), seed = JSON.parse(fs.readFileSync(info.seed, 'utf8'));
  assert.equal(retained.penetration.composer.rows[0].inputs.T, 'Unscheduled composer retained');
  assert.equal(retained.penetration.composer.rows[0].inputs.O, 3);
  await page.getByRole('button', { name: 'Estimates', exact: true }).click();
  await page.locator('#main-estimate-form').getByLabel('Client', { exact: true }).fill('Project copy client');
  const sharedBefore = await api(`/api/libraries/penetration/${info.item_id}/edit`), databaseBefore = sharedDatabase();
  const originalSource = fs.readFileSync(path.join(output, 'reference-library/library.json'));
  const originalImage = fs.readFileSync(info.diagram);
  const uploadPath = path.join(output, 'project-diagram.png');
  const imageFixture = spawnSync(python, ['-c', "from PIL import Image, ImageDraw; import sys; im=Image.new('RGB',(640,360),'#edf4ff'); d=ImageDraw.Draw(im); d.rectangle((40,45,600,305),outline='#19678f',width=9); d.ellipse((235,95,405,265),fill='#cb0018'); d.text((55,20),'SYNTHETIC PROJECT-ONLY DIAGRAM',fill='#102d48'); im.save(sys.argv[1],format='PNG')", uploadPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(imageFixture.status, 0, imageFixture.stderr);

  await enterLibraries(); await chooseLibrary(page, 'pricing');
  await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first();
  const priceIdentity = await price.evaluate(control => ({ id: control.closest('tr').dataset.priceId, kind: control.closest('tr').dataset.priceKind }));
  await price.fill('789.12'); await price.press('Tab');
  await chooseLibrary(page, 'penetration');
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator(`[data-library-edit="${info.item_id}"]`).first().click();
  await expect(page.locator('#firestopping-library-editor')).toBeVisible();
  const layouts={};
  for(const [width,height] of [[1146,764],[390,844]])layouts[width]=await editorLayout(width,height);
  await page.setViewportSize({width:1440,height:1000});evidence.editorLayout=layouts;
  const description = page.locator('[data-library-editor-field="T"]'), quantity = page.locator('[data-library-editor-field="O"]');
  await description.fill('Project-only edited library item');
  await quantity.fill('2.125'); await quantity.press('Tab');
  await page.locator('#library-editor-diagram-file').setInputFiles(uploadPath);
  await libraryIdle(); await picture();
  await page.locator('#library-editor-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'library-edits-before-project-save.png') });
  const pendingDiagram={filename:'project-diagram.png',content_base64:fs.readFileSync(uploadPath).toString('base64')};
  for(const kind of ['pdf','xlsx'])await editorExport(kind,'shared-unsaved',sharedBefore.configuration,pendingDiagram);
  const editorToggle=page.locator('[aria-controls="library-editor-document-actions"]'),editorMenu=page.locator('#library-editor-document-actions');
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']) {
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    for(const width of [1146,390]) {
      await page.setViewportSize({width,height:1000});await editorToggle.click();await expect(editorMenu).toBeVisible();
      const bounds=await editorMenu.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,'Library item Document menu remains within the viewport');
      await expect(editorMenu.getByRole('button',{name:'Item Details',exact:true})).toHaveCount(2);
      await page.screenshot({path:path.join(output,`library-item-documents-${theme}-${width}.png`)});await page.keyboard.press('Escape');
    }
    await cycleTheme(page);
  }
  await page.setViewportSize({width:1440,height:1000});
  choose({});
  // Save immediately after a fresh edit: no Recalculate button or manual delay
  // is required to collect the pending library draft.
  await description.fill('Project-only edited library item saved immediately');
  const firstSave = await reply(() => clickProjectControl(page, 'Save'), '/api/project/save');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await expect(page.locator('#library-editor-save')).toHaveText('Keep in project draft');
  const first = JSON.parse(fs.readFileSync(info.project, 'utf8')), copy = first.library_drafts.records[0];
  assert.equal(copy.id, info.item_id); assert.equal(copy.draft.rows[0].inputs.T, 'Project-only edited library item saved immediately'); assert.equal(copy.draft.rows[0].inputs.O, 2.125);
  assert.equal(copy.diagram.filename, `${info.item_id}.jpg`);
  assert.notDeepEqual(Buffer.from(copy.diagram.content_base64, 'base64'), originalImage, 'Uploaded project diagram is retained as its validated JPEG');
  assert.match(await picture(), /^data:image\/jpeg;base64,/);
  assert.equal(first.estimate.configuration[priceIdentity.kind][priceIdentity.id].supplier_price, 789.12);
  assert.equal(first.estimate.client, 'Project copy client'); assert.equal(first.estimate.measurements, seed.estimate.measurements);
  assert.deepEqual(await independentDrafts(), retained); assert.deepEqual(first.calculators, seed.calculators);
  assert.deepEqual(first.penetration, seed.penetration);
  assert.deepEqual(await api(`/api/libraries/penetration/${info.item_id}/edit`), sharedBefore);
  assert.deepEqual(sharedDatabase(), databaseBefore);
  assert.deepEqual(fs.readFileSync(path.join(output, 'reference-library/library.json')), originalSource);
  assert.deepEqual(fs.readFileSync(info.diagram), originalImage);
  evidence.firstSave = { file: firstSave.file.path, libraryId: copy.id, quantity: copy.draft.rows[0].inputs.O, pricing: priceIdentity, sharedDatabaseUnchanged: true, sharedLibraryUnchanged: true, independentDraftsPreserved: true };
  console.log('Top Save captured shared pricing and library edits only in this project; shared database and independent drafts remain unchanged.');

  await quantity.fill('4.875'); await quantity.press('Tab');
  await reply(() => clickProjectControl(page, 'Save'), '/api/project/save');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const second = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  assert.equal(second.library_drafts.records[0].draft.rows[0].inputs.O, 4.875);
  assert.deepEqual(second.library_drafts.records[0].diagram, copy.diagram);
  assert.deepEqual(sharedDatabase(), databaseBefore);
  assert.deepEqual(await api(`/api/libraries/penetration/${info.item_id}/edit`), sharedBefore);
  await page.locator('#library-editor-save').click(); await expect(page.locator('#firestopping-library-editor')).toBeHidden();
  await openProjectCopy(); await picture();
  await description.fill('Project-only edited library item');await quantity.fill('2.125');await quantity.press('Tab');await libraryIdle();
  for(const kind of ['pdf','xlsx'])await editorExport(kind,'portable-unsaved',second.library_drafts.records[0].configuration,second.library_drafts.records[0].diagram);
  await page.locator('#library-editor-diagram-remove').click();await libraryIdle();
  await editorExport('pdf','portable-removed-diagram',second.library_drafts.records[0].configuration,null);
  await page.locator('#library-editor-diagram-remove').click();await libraryIdle();
  await page.screenshot({ path: path.join(output, 'project-library-copy-saved.png') });
  await page.locator('#library-editor-cancel').click();

  // Remove only the synthetic fixture's shared record to prove the project is
  // self-contained and does not silently rebind to shared storage on reopen.
  const deleted = await page.request.post(`http://127.0.0.1:${info.port}/api/libraries/penetration/${info.item_id}/delete`, { data: {} });
  assert.equal(deleted.status(), 200, await deleted.text());
  assert.equal((await page.request.get(`http://127.0.0.1:${info.port}/api/libraries/penetration/${info.item_id}/edit`)).status(), 404);
  const afterDelete = sharedDatabase();
  await load(false);
  await page.evaluate(() => window.CeasefireLibraries.invalidate());
  const sharedReads = requests.filter(request => request.path === `/api/libraries/penetration/${info.item_id}/edit`).length;
  await openProjectCopy();
  await expect(description).toHaveValue('Project-only edited library item saved immediately');
  await quantity.focus(); await expect(quantity).toHaveValue('4.875');
  assert.match(await picture(), /^data:image\/jpeg;base64,/);
  assert.equal(requests.filter(request => request.path === `/api/libraries/penetration/${info.item_id}/edit`).length, sharedReads);
  assert.deepEqual(await independentDrafts(), retained);
  assert.deepEqual(sharedDatabase(), afterDelete);
  assert.deepEqual(fs.readFileSync(path.join(output, 'reference-library/library.json')), originalSource);
  assert.deepEqual(fs.readFileSync(info.diagram), originalImage);
  await page.locator('#library-editor-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'reopened-orphan-project-copy.png') });
  const csp = await page.evaluate(() => window.qaCsp);
  assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  assert.equal(requests.some(request => request.method === 'POST' && /\/api\/libraries\/penetration\/[^/]+\/save$/.test(request.path)), false);
  assert.equal(requests.some(request => request.method === 'POST' && request.path === '/api/configuration'), false);
  evidence.secondSave = { quantity: 4.875, diagramBytesUnchanged: true };
  evidence.reopen = { sourceSharedRecordDeleted: true, projectCopyOpenedWithoutSharedRead: true, actualDiagramRendered: true, quoteCalculatorsComposerPreserved: true };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, viewport: page.viewportSize(), fixture: info, evidence, errors, csp, requests, sharedBefore: databaseBefore, sharedAfterFixtureDelete: afterDelete }, null, 2));
  console.log(`PASS: rendered project library capture, pricing isolation, second Save, orphan reopen and image preservation. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) {
    const readiness=await page.evaluate(()=>({pending:window.CeasefireLibraryEditor?.hasPendingOperation(),active:{tag:document.activeElement?.tagName,id:document.activeElement?.id},status:document.querySelector('#library-editor-status')?.textContent,message:document.querySelector('#library-editor-message')?.textContent,menu:document.querySelector('#library-editor-document-actions')?.outerHTML})).catch(()=>null);
    fs.writeFileSync(path.join(output,'export-readiness.json'),JSON.stringify({error:String(error),readiness,exportReadiness,errors,requests},null,2));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
