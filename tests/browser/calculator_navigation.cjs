const { chooseLibrary } = require('./section_navigation.cjs');
// Native navigation acceptance against disposable synthetic data only. Hover,
// keyboard and touch must select the existing workspaces without replacing drafts.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `calculator-navigation-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const assets = ['static/app.js', 'static/calculators.js', 'static/calculators.css', 'static/index.html', 'static/styles.css', 'static/penetration.js'];
const assetHashes = Object.fromEntries(assets.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const destinations = ['Steel (spray)', 'Steel (board)', 'Ductwork (spray/wrap)', 'Firestopping'];
function monitor(target) {
  target.setDefaultTimeout(60000); target.on('pageerror', error => errors.push(error.message));
  target.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  return target.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
}
async function idle(target = page) { await target.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function snapshots() { return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details() })); }
async function workbook(title) {
  await expect(page.locator('#calculator-workspace')).toBeVisible(); await expect(page.locator('#estimator-penetration')).toBeHidden();
  await expect(page.locator('#calculator-title')).toHaveText(title); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false');
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await monitor(page);
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline')); await idle();
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  const saveReply = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/project/save-as' && reply.request().method() === 'POST');
  await clickProjectControl(page, 'Save'); assert.equal((await saveReply).status(), 200); await idle();
  await page.getByRole('button', { name: 'Calculators', exact: true }).click(); await workbook('Steel (spray)');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  evidence.initialCalculator = 'Steel (spray)';
  const calculationRequests = () => requests.filter(item => item.path.startsWith('/api/calculators/')).length;
  const before = await snapshots(), beforeRequests = calculationRequests();
  const estimateToggle=page.getByRole('button',{name:'Estimates',exact:true}), estimates=page.getByRole('group',{name:'Choose an estimate',exact:true});
  await estimateToggle.hover();await expect(estimates).toBeVisible();
  assert.deepEqual(await estimates.getByRole('button').allTextContents(),['Main']);
  assert.deepEqual(await snapshots(),before);assert.equal(calculationRequests(),beforeRequests);
  await chooseCalculator(page,'Firestopping');await idle();
  await expect(page.locator('#view-calculators')).toBeVisible();await expect(page.locator('#view-estimate')).toBeHidden();
  await expect(page.locator('#estimator-penetration')).toBeVisible();await expect(page.locator('#estimator-main')).toBeHidden();
  await estimateToggle.hover();await estimates.getByRole('button',{name:'Main',exact:true}).click();await idle();
  await expect(page.locator('#estimator-main')).toBeVisible();await expect(page.locator('#estimator-penetration')).toBeHidden();
  assert.deepEqual(await snapshots(),before);
  const toggle = page.getByRole('button', { name: 'Calculators', exact: true }), menu = page.getByRole('group', { name: 'Choose a calculator', exact: true });
  await expect(page.locator('#calculator-list')).toHaveCount(0); await expect(page.locator('.calculator-choice')).toHaveCount(0);
  await toggle.hover(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(menu).toBeVisible();
  assert.deepEqual(await menu.getByRole('button').allTextContents(), destinations);
  await page.mouse.move(0, 0); await expect(menu).toBeHidden(); assert.deepEqual(await snapshots(), before);
  assert.equal(calculationRequests(), beforeRequests, 'Hover must not open a calculator or make a calculation request');
  evidence.hover = { destinations, changedDrafts: false, openedCalculator: false, requestedCalculation: false };

  await toggle.focus(); await expect(menu).toBeVisible(); await toggle.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(menu.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(menu.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(menu).toBeHidden();
  assert.deepEqual(await snapshots(), before);
  await toggle.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('button', { name: 'Steel (board)', exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await workbook('Steel (board)');
  assert.deepEqual(await snapshots(), before); evidence.keyboard = { focus: true, arrows: true, homeEnd: true, escapeReturnsFocus: true, enterSelectsCalculator: true, changedDrafts: false };
  await page.getByRole('button', { name: 'Home', exact: true }).click(); await toggle.click(); await workbook('Steel (board)');
  assert.deepEqual(await snapshots(), before);

  // Select every real calculator, then retain an edited schedule value and its
  // current page while navigating through the other workspaces.
  await chooseCalculator(page, 'Steel (spray)'); await workbook('Steel (spray)');
  await page.locator('#calculator-pages button').filter({ hasText: /^SCHEDULE$/ }).click(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false');
  const input = page.locator('[data-calculator-sheet="SCHEDULE"][data-calculator-cell="A10"]'); await expect(input).toBeVisible(); await input.fill('MENU-DRAFT-1'); await input.press('Tab');
  await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false'); const retained = await snapshots();
  for (const title of ['Steel (board)', 'Ductwork (spray/wrap)']) { await chooseCalculator(page, title); await workbook(title); }
  await chooseCalculator(page, 'Firestopping Estimator'); await idle(); await expect(page.locator('#estimator-penetration')).toBeVisible(); await expect(page.locator('#calculator-workspace')).toBeHidden();
  await chooseCalculator(page, 'Steel (spray)'); await workbook('Steel (spray)'); await expect(page.locator('#calculator-sheet-title')).toHaveText('SCHEDULE'); await expect(input).toHaveValue('MENU-DRAFT-1');
  assert.deepEqual(await snapshots(), retained); evidence.selection = { allDestinations: true, unsavedScheduleRetained: true, pageRetained: true, unrelatedDraftsUnchanged: true };
  for (const title of ['Steel (spray)', 'Steel (board)', 'Ductwork (spray/wrap)', 'Firestopping']) {
    await chooseCalculator(page, title); await idle();
    await page.getByRole('button', { name: 'Home', exact: true }).click(); await toggle.click(); await idle();
    if (title === 'Firestopping') { await expect(page.locator('#estimator-penetration')).toBeVisible(); await expect(page.locator('#calculator-workspace')).toBeHidden(); }
    else await workbook(title);
    assert.deepEqual(await snapshots(), retained);
    await page.getByRole('button', { name: 'Home', exact: true }).click(); await page.locator('[data-home-view="calculators"]').click(); await idle();
    if (title === 'Firestopping') await expect(page.locator('#estimator-penetration')).toBeVisible(); else await workbook(title);
    assert.deepEqual(await snapshots(), retained);
  }
  evidence.lastCalculator = { headerReturnsToEveryCalculator: true, homeCardReturnsToEveryCalculator: true, draftsUnchanged: true };

  // Menu navigation uses the established library confirmation, including its
  // cancellation behavior. An explicit Continue retains the unsaved prices.
  await page.getByRole('button', { name: 'Libraries', exact: true }).click(); await chooseLibrary(page, 'pricing'); await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first(); await price.fill('789.12345'); await price.press('Tab');
  const priceDisplay = await price.inputValue(); assert.equal(priceDisplay, '789.12');
  const guarded = await snapshots(); await chooseCalculator(page, 'Steel (board)');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('heading')).toHaveText('Unsaved Pricing Library');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('#view-pricing')).toBeVisible(); await expect(price).toHaveValue(priceDisplay); assert.deepEqual(await snapshots(), guarded);
  await chooseCalculator(page, 'Steel (board)'); await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await workbook('Steel (board)'); assert.deepEqual(await snapshots(), guarded);
  assert.ok(!requests.some(item => item.method !== 'GET' && /\/api\/(?:pricing|calculators)\/.+state$|\/api\/pricing$/.test(item.path)), 'Navigation must not save pricing or calculator defaults');
  evidence.pricingGuard = { cancelPreservesView: true, cancelPreservesPriceAndDrafts: true, continueKeepsUnsavedPrices: true };

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  for (const width of [1600, 1146, 825, 570, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.mouse.move(0, 0); await toggle.hover(); await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `Dropdown escaped viewport at ${width}: ${JSON.stringify(bounds)}`);
    await expect(menu.getByRole('button', { name: 'Ductwork (spray/wrap)', exact: true })).toBeVisible();
    if ([1146, 390].includes(width)) await page.screenshot({ path: path.join(output, `calculator-menu-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Home', exact: true }).click(); await expect(menu).toBeHidden();
  }
  evidence.viewports = [1600, 1146, 825, 570, 390];
  await page.setViewportSize({width:1440,height:1000});
  await expect(page.locator('#view-home .home-card')).toHaveCount(6);
  await page.locator('[data-home-view="help"]').click();await expect(page.locator('#view-help')).toBeVisible();
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.locator('[data-home-view="takeoffs"]').click();await expect(page.locator('#view-takeoffs')).toBeVisible();
  await chooseCalculator(page,'Firestopping');await idle();
  const settings=page.locator('#penetration-settings'),details=page.locator('#penetration-input-groups [role="tab"]').first();
  const gear=await settings.boundingBox(),tab=await details.boundingBox(),add=await page.locator('#penetration-add-to-schedule').boundingBox(),library=await page.locator('#penetration-add-to-library').boundingBox();
  assert.ok(gear.x+gear.width<=tab.x,'Settings icon is left of the first Details tab');assert.ok(add.x+add.width<=library.x,'Add to Library is immediately right of Add to Schedule');assert.ok(Math.abs(add.y-library.y)<1&&Math.abs(add.height-library.height)<1,'Current-item add actions share the same height and top alignment');
  await expect(page.locator('#penetration-new-item')).toBeHidden();await expect(page.locator('#penetration-recalculate')).toBeHidden();
  for(const id of ['penetration-item-excel','penetration-item-pdf'])assert.equal(await page.locator(`#${id}`).evaluate(el=>el.closest('.penetration-schedule-recalculate-tools').querySelector('#penetration-estimator-schedule-recalculate')!==null),true,'Schedule downloads share the lower schedule Recalculate row');
  const clearBefore=await snapshots(),current=clearBefore.penetration.composer.rows[0];
  const description=page.locator('#penetration-row-fields [data-penetration-field="T"]');await description.fill('CLEAR CURRENT ITEM');await description.press('Tab');
  await page.locator('#penetration-item-quantity [data-penetration-field="O"]').fill('3');await page.locator('#penetration-clear').click();
  await expect(description).toHaveValue('');await expect(page.locator('#penetration-item-quantity [data-penetration-field="O"]')).toHaveValue('');
  const cleared=await snapshots();assert.deepEqual(cleared.penetration.draft,clearBefore.penetration.draft);assert.deepEqual(cleared.penetration.composer.globals,clearBefore.penetration.composer.globals);assert.deepEqual(cleared.penetration.composer.rows,[{id:current.id,inputs:{}}]);assert.deepEqual(cleared.pricing,clearBefore.pricing);assert.deepEqual(cleared.calculators,clearBefore.calculators);
  await page.screenshot({path:path.join(output,'firestopping-clear-controls.png'),fullPage:true});
  evidence.commentsControls={homeTakeoffsAndHelp:true,settingsLeftOfDetails:true,libraryRightOfSchedule:true,headerNewAndRecalculateHidden:true,scheduleDownloadsBelow:true,clearAllInputsAndQuantity:true,clearPreservesScheduleSettingsPricesAndCalculators:true};
  const requiredFields=[['J','Category','Plumbing & Hydraulic'],['K','Service Type','Copper Pipes'],['L','Penetration Type','Core Hole'],['M','Substrate Orientation','Vertical'],['N','FRL','-/120/120'],['P','Substrate','Concrete/masonry wall']];
  const field=column=>page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`);
  for(const [column,,value] of requiredFields){await expect(field(column)).toHaveAttribute('aria-required','true');await field(column).selectOption(value);}
  await page.locator('#penetration-item-quantity [data-penetration-field="O"]').fill('1.23456789012345');const automatic=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/penetration/calculate'&&reply.request().method()==='POST');await description.fill('Required entry native fixture');await description.press('Tab');assert.equal((await automatic).status(),200);await idle();
  const mutationCount=()=>requests.filter(request=>request.method==='POST'&&['/api/penetration/validate-item','/api/libraries/penetration'].includes(request.path)).length;
  for(const [column,label,value] of requiredFields){const count=mutationCount();await field(column).selectOption('');await expect(page.locator('#penetration-add-to-schedule')).toBeDisabled();await expect(page.locator('#penetration-add-to-library')).toBeDisabled();await expect(page.locator('#penetration-required-fields')).toContainText(`Complete ${label} before adding`);assert.equal(mutationCount(),count);await field(column).selectOption(value);}
  await expect(page.locator('#penetration-add-to-schedule')).toBeEnabled();await expect(page.locator('#penetration-add-to-library')).toBeEnabled();await expect(page.locator('#penetration-required-fields')).toBeHidden();
  evidence.requiredFields={eachMissingFieldBlocksBothNewEntries:true,requiredSemantics:true,automaticCalculationWhileRecalculateHidden:true};
  // Capture a real library identity, add that item to the schedule, then use
  // the native Edit/Clear/refill/Update controls on its retained row copy.
  await description.fill('CLEAR LINKED SCHEDULE SOURCE');await description.press('Tab');const quantity=page.locator('#penetration-item-quantity [data-penetration-field="O"]');await quantity.fill('3.123456789');await quantity.press('Tab');
  await page.locator('#penetration-input-groups').getByRole('tab',{name:'Products and labour',exact:true}).click();const crew=page.locator('#penetration-row-fields [data-penetration-field="W"]');await crew.selectOption(await crew.locator('option').evaluateAll(options=>options.find(option=>option.value&&!option.disabled).value));
  await page.locator('#penetration-input-groups').getByRole('tab',{name:'OTHER',exact:true}).click();const additionalLabour=page.locator('#penetration-row-fields [data-penetration-field="AH"]');await additionalLabour.fill('1');await additionalLabour.press('Tab');await page.locator('#penetration-input-groups').getByRole('tab',{name:'DETAILS',exact:true}).click();
  const capturedReply=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/libraries/penetration'&&reply.request().method()==='POST');capturedReply.catch(()=>{});await page.locator('#penetration-add-to-library').click();
  await expect(dialog.getByRole('heading')).toHaveText('Are you sure you want to add this item to the Firestopping Library?');await dialog.getByRole('button',{name:'Yes',exact:true}).click();const capture=await capturedReply;assert.equal(capture.status(),200,await capture.text());const libraryItem=await capture.json();await expect(page.locator('#penetration-add-to-library')).toHaveAttribute('aria-busy','false');
  assert.equal((await snapshots()).penetration.composer.rows[0].library_item_id,libraryItem.id);await page.locator('#penetration-add-to-schedule').click();await expect(page.locator('#penetration-add-to-schedule')).toHaveAttribute('aria-busy','false');
  const linkedBefore=await snapshots(),linkedRow=linkedBefore.penetration.draft.rows.at(-1);assert.equal(linkedRow.library_item_id,libraryItem.id);
  const scheduleDetails=page.locator('details[aria-labelledby="penetration-estimator-schedule-heading"]');if(!await scheduleDetails.evaluate(element=>element.open))await scheduleDetails.locator(':scope > summary').click();await page.locator(`#penetration-estimator-schedule-body [data-penetration-id="${linkedRow.id}"]`).getByRole('button',{name:`Edit firestopping item ${linkedBefore.penetration.draft.rows.length}`,exact:true}).click();
  if(await dialog.isVisible()){await expect(dialog.getByRole('heading')).toHaveText('Edit schedule item?');await dialog.getByRole('button',{name:'Edit item',exact:true}).click();}
  await expect(page.locator('#penetration-update-schedule')).toBeVisible();await page.locator('#penetration-clear').click();const linkedCleared=await snapshots();
  assert.deepEqual(linkedCleared.penetration.draft,linkedBefore.penetration.draft);assert.deepEqual(linkedCleared.penetration.composer.rows,[{id:linkedRow.id,inputs:{},library_item_id:libraryItem.id}]);assert.deepEqual(linkedCleared.pricing,linkedBefore.pricing);assert.deepEqual(linkedCleared.calculators,linkedBefore.calculators);await expect(page.locator('#penetration-update-schedule')).toBeEnabled();
  await description.fill('REFILLED LINKED SOURCE');await description.press('Tab');await quantity.fill('4.987654321');await quantity.press('Tab');await page.locator('#penetration-update-schedule').click();await expect(page.locator('#penetration-update-schedule')).toBeHidden();await expect(page.locator('#penetration-update-schedule')).toHaveAttribute('aria-busy','false');
  const linkedUpdated=await snapshots();assert.deepEqual(linkedUpdated.penetration.draft.rows.at(-1),{id:linkedRow.id,inputs:{T:'REFILLED LINKED SOURCE',O:4.987654321},library_item_id:libraryItem.id});assert.deepEqual(linkedUpdated.penetration.draft.rows.slice(0,-1),linkedBefore.penetration.draft.rows.slice(0,-1));assert.deepEqual(linkedUpdated.penetration.draft.globals,linkedBefore.penetration.draft.globals);assert.deepEqual(linkedUpdated.pricing,linkedBefore.pricing);assert.deepEqual(linkedUpdated.calculators,linkedBefore.calculators);evidence.clearLinkedEditRetainsLibraryAndRowIdentity=true;
  evidence.firestoppingDocuments = [];
  for (const [headingId, prefix] of [['penetration-estimator-schedule-heading', 'penetration-item'], ['penetration-schedule-heading', 'penetration']]) {
    if (prefix === 'penetration') { await page.getByRole('button', { name: 'Estimates', exact: true }).click(); await idle(); }
    const schedule = page.locator(`details[aria-labelledby="${headingId}"]`);
    if (!await schedule.evaluate(element => element.open)) await schedule.locator(':scope > summary').click();
    const documentToggle = schedule.getByRole('button', { name: 'Document', exact: true }), documentActions = schedule.getByRole('group', { name: 'Document actions', exact: true });
    await expect(documentActions).toBeHidden(); await documentToggle.click(); await expect(documentActions).toBeVisible();
    assert.equal(await documentActions.getByRole('button').count(), 2);
    for (const width of [390, 1146]) {
      await page.setViewportSize({ width, height: 1000 }); const bounds = await documentActions.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `Firestopping Document menu stays within ${width}px viewport`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await documentToggle.press('ArrowDown'); await expect(documentActions.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(documentToggle).toBeFocused(); await expect(documentActions).toBeHidden();
    for (const [suffix, magic] of [['excel', 'PK'], ['pdf', '%PDF']]) {
      await documentToggle.click(); const action = page.locator(`#${prefix}-${suffix}`); await expect(action).toBeVisible();
      const endpoint = `/api/penetration/${suffix === 'pdf' ? 'report.pdf' : 'register.xlsx'}`;
      const download = page.waitForResponse(reply => new URL(reply.url()).pathname === endpoint && reply.request().method() === 'POST');
      await action.click(); const reply = await download; assert.equal(reply.status(), 200); const file = await reply.json();
      assert.equal(file.saved, true); assert.equal(file.destination, 'project');
      const relative = path.relative(output, file.path); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(fs.readFileSync(file.path).subarray(0, magic.length).toString(), magic);
      await expect(documentActions).toBeHidden(); await idle(); assert.deepEqual(await snapshots(), linkedUpdated);
      evidence.firestoppingDocuments.push(`${prefix}-${suffix}`);
    }
  }
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touch = await touchContext.newPage(); await monitor(touch); await touch.goto(`http://127.0.0.1:${info.port}/`); await idle(touch);
  await touch.getByRole('button', { name: 'Calculators', exact: true }).tap();
  const touchMenu = touch.getByRole('group', { name: 'Choose a calculator', exact: true }); await expect(touchMenu).toBeVisible();
  await touchMenu.getByRole('button', { name: 'Steel (board)', exact: true }).tap(); await expect(touch.locator('#calculator-title')).toHaveText('Steel (board)', { timeout: 60000 }); await expect(touch.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 }); await expect(touchMenu).toBeHidden();
  evidence.touch = { disclosureTap: true, chosenCalculator: 'Steel (board)' };
  assert.deepEqual(await touch.evaluate(() => window.qaCsp), []); await touchContext.close();
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, assetHashes, evidence, errors, csp: [] }, null, 2));
  console.log(`PASS: native calculator menu hover, keyboard, touch, all destinations, draft preservation and Pricing Library guard. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000)); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
