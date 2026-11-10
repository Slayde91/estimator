// Real pointer paths and native hit testing for menus over a wrapped header.
// The server, PDFs and project dialogs are disposable and never use port 8765.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { chooseTakeoff, chooseLibrary } = require('./section_navigation.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `navigation-stack-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = '';
  const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } });
  server.once('error', reject);
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = { widths: [], keyboard: [], touch: [] };
// Certification's separate editor work may update its own HTML region while this
// focused test runs. Freeze the three production scripts/styles this test owns.
const navigationAssets = ['static/app.js','static/takeoffs.js','static/styles.css'];
const navigationHashes = Object.fromEntries(navigationAssets.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
async function idle(target = page) {
  await target.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; });
}
async function pointerTo(choice, target = page) {
  const bounds = await choice.boundingBox(); assert.ok(bounds);
  await target.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 14 });
  await expect(choice).toBeVisible();
  assert.equal(await choice.evaluate(el => {
    const b = el.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return hit === el || el.contains(hit);
  }), true, 'The actual pointer target must be the requested menu choice');
}
async function openMenu(id, width) {
  const toggle = page.locator(`#${id}-toggle`), menu = page.locator(`#${id}-menu`);
  await toggle.hover(); await expect(menu).toBeVisible();
  const button = await toggle.boundingBox(), dropdown = await menu.boundingBox();
  assert.ok(Math.abs(dropdown.y - button.y - button.height) < 1, `Menu anchors directly below its owner at ${width}: ${id}`);
  assert.ok(dropdown.x >= 13 && dropdown.x + dropdown.width <= width - 13, `Menu fits the viewport at ${width}: ${id}`);
  // Travel through the visible corridor under this button. A diagonal across
  // another header button intentionally opens that other button's menu.
  await page.mouse.move(button.x + button.width / 2, dropdown.y + 2, { steps: 8 });
  await expect(menu).toBeVisible();
  return { toggle, menu, button, dropdown };
}
async function enterSubmenu(parent, submenu) {
  await expect(submenu).toBeVisible();
  const button = await parent.boundingBox(), menu = await submenu.boundingBox();
  if (menu.x + menu.width <= button.x + 1) {
    await page.mouse.move(menu.x + menu.width - 2, button.y + button.height / 2, { steps: 10 });
  } else if (menu.x >= button.x + button.width - 1) {
    await page.mouse.move(menu.x + 2, button.y + button.height / 2, { steps: 10 });
  } else {
    await page.mouse.move(button.x + button.width / 2, menu.y + 2, { steps: 10 });
  }
  await expect(submenu).toBeVisible();
}
async function takeoffIdle() {
  await idle();
  await expect(page.locator('#takeoff-pages button:disabled')).toHaveCount(0);
  await page.waitForFunction(()=>!window.CeasefireTakeoffs.hasPendingOperation());
}
async function workspaceSnapshot() {
  await takeoffIdle();
  return page.evaluate(()=>({details:window.CeasefireProject.details(),pricing:window.CeasefireProject.configuration(),
    calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),
    takeoffs:window.CeasefireTakeoffs.projectSnapshot()}));
}
async function checkWorkspaceTabs(info) {
  await page.setViewportSize({width:1254,height:1000});
  await chooseTakeoff(page,'Steel');await takeoffIdle();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await page.waitForFunction(()=>{
    if(window.CeasefireTakeoffs.hasPendingOperation())return false;
    const graph=window.CeasefireTakeoffs.projectSnapshot();
    return graph?.documents.length===1&&graph.render_checks?.some(check=>check.document_id===graph.documents[0].id&&check.page===1&&check.success);
  });
  // Seed a real, nonempty drawing graph through its native rectangle tool. The
  // subsequent tab checks must preserve the exact source and graphic records.
  await page.locator('.takeoff-markup-rail').getByRole('button',{name:'Rectangle',exact:true}).click();
  const overlay=page.locator('.takeoff-overlay');await overlay.scrollIntoViewIfNeeded();
  const points=await overlay.evaluate(element=>{
    const drawing=element.getBoundingClientRect(),viewport=element.closest('.takeoff-viewport').getBoundingClientRect();
    const header=document.querySelector('.app-header').getBoundingClientRect();
    const left=Math.max(drawing.left,viewport.left,0),right=Math.min(drawing.right,viewport.right,innerWidth);
    const top=Math.max(drawing.top,viewport.top,header.bottom),bottom=Math.min(drawing.bottom,viewport.bottom,innerHeight);
    if(right-left<60||bottom-top<60)throw Error('Synthetic drawing does not have enough visible space for a rectangle');
    return [[left+(right-left)*.3,top+(bottom-top)*.3],[left+(right-left)*.6,top+(bottom-top)*.6]];
  });
  const created=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.op==='create_graphic');
  for(const point of points){
    assert.equal(await page.evaluate(([x,y])=>Boolean(document.elementFromPoint(x,y)?.closest('.takeoff-overlay')),point),true);
    await page.mouse.click(...point);
  }
  const graphicResponse=await created;assert.equal(graphicResponse.status(),200,await graphicResponse.text());await takeoffIdle();
  const takeoffTabs=page.locator('#takeoff-pages'),libraryTabs=page.locator('#library-pages');
  const takeoffs=[['steel',null,'Steel'],['duct',null,'Duct'],['walls_floors',null,'Walls/Floors'],
    ['physical','defect_reports','Defect Reports'],['physical','service_plans','Service Plans']];
  const libraries=[['pricing','Pricing Library'],['penetration','Firestopping Library'],['technical','Technical Library']];
  const takeoffButton=([mode,scope])=>takeoffTabs.locator(`[data-mode="${mode}"]${scope?`[data-physical-scope="${scope}"]`:':not([data-physical-scope])'}`);
  async function prepareStrip(){
    // The PDF seed scrolls below the sticky header. Return to the visible strip
    // and dismiss its header disclosure before travelling to a tab underneath.
    await page.evaluate(()=>scrollTo(0,0));await page.mouse.move(0,0);await page.keyboard.press('Escape');
  }
  async function selectTakeoff(target){
    await prepareStrip();
    await takeoffButton(target).click();await takeoffIdle();
    await expect(takeoffTabs.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(takeoffButton(target)).toHaveAttribute('aria-pressed','true');
    const [mode,scope]=target;
    await expect(page.locator('.takeoff-workspace-heading')).toHaveAttribute('data-takeoff-mode',mode==='walls_floors'?'wall':mode);
    const header=page.locator(`#takeoff-navigation-menu [data-mode="${mode}"]${scope?`[data-physical-scope="${scope}"]`:':not([data-physical-scope])'}`);
    await expect(header).toHaveAttribute('aria-pressed','true');
    if(scope)await expect(page.locator('.takeoff-physical-register')).toBeVisible();
  }
  async function selectLibrary(kind){
    await prepareStrip();
    await libraryTabs.locator(`[data-library-kind="${kind}"]`).click();await idle();
    await expect(page.locator('#library-'+kind)).toBeVisible();
    await expect(libraryTabs.locator('[aria-pressed="true"]')).toHaveAttribute('data-library-kind',kind);
    await expect(page.locator(`#library-navigation-menu [data-library-kind="${kind}"]`)).toHaveAttribute('aria-pressed','true');
  }
  for(const target of takeoffs)await selectTakeoff(target);
  await chooseLibrary(page,'pricing');await idle();
  for(const [kind]of libraries)await selectLibrary(kind);
  await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});
  const before=await workspaceSnapshot(),requestStart=requests.length;
  assert.equal(before.takeoffs.documents.length,1);assert.equal(before.takeoffs.graphics.records.length,1);
  const sourceHash=crypto.createHash('sha256').update(fs.readFileSync(info.fixture)).digest('hex');
  evidence.workspaceTabs={takeoffDestinations:takeoffs,libraryDestinations:libraries,layouts:[],rtl:[],nonemptyGraph:true};
  async function layout(strip,name,width){
    await page.evaluate(()=>scrollTo(0,0));
    const box=await strip.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    assert.equal(await strip.evaluate(element=>getComputedStyle(element).height),'40px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1),false,'Tab overflow stays within its local strip');
    await page.screenshot({path:path.join(output,`${name}-tabs-${await page.locator('html').getAttribute('dir')||'ltr'}-${width}.png`)});
    evidence.workspaceTabs.layouts.push({name,width,box});
  }
  for(const width of [1254,390]){
    await page.setViewportSize({width,height:1000});await page.locator('#takeoff-navigation-toggle').click();await takeoffIdle();
    await expect(takeoffTabs.getByRole('button')).toHaveText(takeoffs.map(target=>target[2]));
    for(const target of takeoffs){await selectTakeoff(target);assert.deepEqual(await workspaceSnapshot(),before);}
    await layout(takeoffTabs,'takeoff',width);
    await page.locator('#library-navigation-toggle').click();await idle();
    await expect(libraryTabs.getByRole('button')).toHaveText(libraries.map(target=>target[1]));
    for(const [kind]of libraries){await selectLibrary(kind);assert.deepEqual(await workspaceSnapshot(),before);}
    await layout(libraryTabs,'library',width);
  }
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('ar',false));await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  for(const width of [1254,390]){
    await page.setViewportSize({width,height:1000});
    for(const [id,strip,labels]of [['library-navigation-toggle',libraryTabs,libraries.map(row=>row[1])],['takeoff-navigation-toggle',takeoffTabs,takeoffs.map(row=>row[2])]]){
      await page.locator('#'+id).click();await takeoffIdle();
      await prepareStrip();
      const translated=await page.evaluate(labels=>labels.map(label=>window.CeasefireI18n.translate(label)),labels);
      await expect(strip.getByRole('button')).toHaveText(translated);
      const buttons=strip.getByRole('button');await buttons.first().focus();await page.keyboard.press('End');await expect(buttons.last()).toBeFocused();
      await page.keyboard.press('Home');await expect(buttons.first()).toBeFocused();
      await page.keyboard.press('ArrowLeft');await expect(buttons.nth(1)).toBeFocused();
      await page.keyboard.press('ArrowRight');await expect(buttons.first()).toBeFocused();
      await page.keyboard.press('ArrowLeft');await page.keyboard.press('Enter');await takeoffIdle();
      if(id==='library-navigation-toggle')await expect(page.locator('#library-penetration')).toBeVisible();
      else await expect(page.locator('.takeoff-workspace-heading')).toHaveAttribute('data-takeoff-mode','duct');
      assert.deepEqual(await workspaceSnapshot(),before);await layout(strip,id.startsWith('library')?'library':'takeoff',width);
      evidence.workspaceTabs.rtl.push({strip:await strip.getAttribute('id'),width,translated,arrows:true,nativeEnter:true});
    }
  }
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
  await page.locator('#library-navigation-toggle').click();await idle();await selectLibrary('pricing');
  await page.locator('#pricing-scope').selectOption('library');
  const price=page.locator('#pricing-body [data-price-field="supplier_price"]').first();await price.fill('789.12345');await price.press('Tab');
  await expect(price).toHaveValue('789.12');const dirty=await workspaceSnapshot();
  await libraryTabs.locator('[data-library-kind="technical"]').click();
  const prompt=page.getByRole('dialog',{name:'Unsaved Pricing Library',exact:true});await expect(prompt).toBeVisible();
  await prompt.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#library-pricing')).toBeVisible();await expect(price).toHaveValue('789.12');
  await expect(libraryTabs.locator('[aria-pressed="true"]')).toHaveAttribute('data-library-kind','pricing');assert.deepEqual(await workspaceSnapshot(),dirty);
  await libraryTabs.locator('[data-library-kind="technical"]').click();await prompt.getByRole('button',{name:'Continue',exact:true}).click();await idle();
  await expect(page.locator('#library-technical')).toBeVisible();await selectLibrary('pricing');await expect(price).toHaveValue('789.12');
  assert.deepEqual(await workspaceSnapshot(),dirty);
  const navigationRequests=requests.slice(requestStart);
  assert.equal(navigationRequests.filter(row=>row.path.endsWith('/commands')&&row.op!=='record_render').length,0,'Tab changes do not mutate existing drawing graphs');
  assert.equal(navigationRequests.filter(row=>!['GET','HEAD'].includes(row.method)&&(/^\/api\/project\/(?:save|save-as)$/.test(row.path)||row.path==='/api/configuration')).length,0,'Tab changes and confirmation do not save Projects or shared prices');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.fixture)).digest('hex'),sourceHash);
  evidence.workspaceTabs.pricingGuard={cancelRetainsViewAndSelection:true,continueRetainsUnsavedPrice:true,noImplicitSaves:true};
  evidence.workspaceTabs.nonReadNavigationRequests=navigationRequests.filter(row=>!['GET','HEAD'].includes(row.method));
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 764 } });
  page.setDefaultTimeout(60000); page.on('pageerror', error => errors.push(error.message));
  page.on('request',request=>{let op;try{op=request.postDataJSON()?.op;}catch{}requests.push({method:request.method(),path:new URL(request.url()).pathname,...(op?{op}:{} )});});
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  for (const width of [320, 390, 671, 720, 910, 1084, 1440]) {
    await page.setViewportSize({ width, height: 764 });
    await page.getByRole('button', { name: 'Home', exact: true }).click(); await idle();
    const rows = await page.locator('.app-header nav > .nav-button, .app-header nav > div > .nav-button').evaluateAll(nodes => [...new Set(nodes.map(el => Math.round(el.getBoundingClientRect().y)))]);
    if (width <= 720) assert.equal(rows.length, 2, 'The regression is exercised with actual stacked buttons');

    const estimates = await openMenu('estimate-navigation', width);
    const estimate = estimates.menu.locator('[data-estimator-kind="estimate"]');
    await pointerTo(estimate); await estimate.click(); await idle();
    await expect(page.locator('#view-estimate')).toBeVisible();

    const calculators = await openMenu('calculator-navigation', width);
    const steel = calculators.menu.locator('#steel-calculator-navigation-toggle');
    await pointerTo(steel); await expect(page.locator('#steel-calculator-navigation-menu')).toBeVisible();
    await enterSubmenu(steel, page.locator('#steel-calculator-navigation-menu'));
    const factor = page.locator('#steel-calculator-navigation-menu [data-calculator-id="steel_factors"]');
    await pointerTo(factor); await factor.click(); await idle();
    await expect(page.locator('#calculator-title')).toHaveText('Factor Calcs');

    await openMenu('takeoff-navigation', width);
    const penetration = page.locator('#penetration-navigation-toggle');
    await pointerTo(penetration); await expect(page.locator('#penetration-navigation-menu')).toBeVisible();
    await enterSubmenu(penetration, page.locator('#penetration-navigation-menu'));
    const service = page.locator('#penetration-navigation-menu [data-physical-scope="service_plans"]');
    await pointerTo(service); await service.click(); await idle();
    await expect(page.locator('#view-takeoffs > .takeoff-workspace-heading')).toContainText('Service Plans');

    const libraries = await openMenu('library-navigation', width);
    const pricing = libraries.menu.locator('[data-library-kind="pricing"]');
    await pointerTo(pricing); await pricing.click(); await idle();
    await expect(page.locator('#view-pricing')).toBeVisible();
    // Direct buttons on the second row also remain native click targets.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#view-settings')).toBeVisible();
    let disclosureDismissal = null;
    if (width <= 720) {
      const calculator = page.locator('#calculator-navigation-toggle'), menu = page.locator('#calculator-navigation-menu');
      const settings = page.locator('nav [data-view="settings"]');
      // A returned-to workspace can leave its disclosure open. The menu must
      // receive clicks over the lower row; clicking through would break choices.
      await calculator.click(); await idle(); await expect(menu).toBeVisible();
      const menuOwnsSettingsPoint = await settings.evaluate(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return document.getElementById('calculator-navigation-menu').contains(hit);
      });
      assert.equal(menuOwnsSettingsPoint, true, 'The foreground disclosure owns its actual overlapping pointer target');
      await calculator.press('Escape'); await expect(menu).toBeHidden();
      await settings.click(); await idle(); await expect(page.locator('#view-settings')).toBeVisible();
      await calculator.hover(); await expect(menu).toBeVisible();
      await page.mouse.move(0, 0); await expect(menu).toBeHidden();
      await settings.click(); await expect(page.locator('#view-settings')).toBeVisible();
      disclosureDismissal = { menuOwnsSettingsPoint, escapeRestoresSettingsClick: true, mouseAwayRestoresSettingsClick: true };
    }

    await page.getByRole('button', { name: 'Home', exact: true }).click(); await idle();
    const cards = page.locator('#view-home .home-card');
    assert.equal(await cards.count(), 6);
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i); await card.hover();
      assert.match(await card.evaluate(el => getComputedStyle(el).cursor), /laser-reticle\.svg.*16 16, pointer/);
      assert.match(await card.locator('strong').evaluate(el => getComputedStyle(el).cursor), /laser-reticle\.svg/);
    }
    await openMenu('calculator-navigation', width);
    await page.screenshot({ path: path.join(output, `stacked-menu-${width}.png`) });
    evidence.widths.push({ width, rows: rows.length, estimate: true, calculatorSubmenu: true, servicePlansSubmenu: true, library: true, directButton: true, disclosureDismissal, homeCardReticles: 6 });
    await page.mouse.move(0, 0);
  }

  for (const width of [390, 671, 1440]) {
    await page.setViewportSize({ width, height: 764 });
    const toggle = page.locator('#calculator-navigation-toggle');
    await toggle.focus(); await toggle.press('ArrowDown');
    await expect(page.locator('#calculator-navigation-menu > button').first()).toBeFocused();
    await page.keyboard.press('End'); await expect(page.locator('#steel-calculator-navigation-toggle')).toBeFocused();
    await page.keyboard.press('ArrowRight'); await expect(page.locator('#steel-calculator-navigation-menu > button').first()).toBeFocused();
    await page.keyboard.press('ArrowLeft'); await expect(page.locator('#steel-calculator-navigation-toggle')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(page.locator('#calculator-navigation-menu')).toBeHidden();
    evidence.keyboard.push({ width, arrows: true, escape: true });
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 764 }, hasTouch: true, isMobile: true });
  const touch = await context.newPage();
  await touch.goto(`http://127.0.0.1:${info.port}/`); await idle(touch);
  await touch.locator('#calculator-navigation-toggle').tap();
  await touch.locator('#steel-calculator-navigation-toggle').tap();
  await touch.locator('#steel-calculator-navigation-menu [data-calculator-id="steel_factors"]').tap();
  await idle(touch); await expect(touch.locator('#calculator-title')).toHaveText('Factor Calcs');
  evidence.touch.push({ width: 390, calculatorSubmenu: true });
  await context.close();
  for (const width of [320, 390, 671]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
    const mobile = await context.newPage();
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
    await mobile.goto(`http://127.0.0.1:${info.port}/`); await idle(mobile);
    const geometry = async id => {
      const value = await mobile.locator(id).evaluate(menu => {
        const bounds = menu.getBoundingClientRect(), viewport = visualViewport;
        const owner = document.getElementById(menu.id.replace(/-menu$/, '-toggle')).getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, ownerBottom: owner.bottom, viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth, innerWidth, scrollX,
          visualWidth: viewport.width, visualOffsetLeft: viewport.offsetLeft, visualOffsetTop: viewport.offsetTop };
      });
      assert.equal(value.viewportWidth, width);
      assert.ok(value.left >= 0 && value.right <= width, `Touch menu stays inside the actual viewport: ${JSON.stringify(value)}`);
      assert.ok(Math.abs(value.top - value.ownerBottom) < 1, 'The touch menu stays directly below its actual owner');
      assert.ok(value.documentWidth <= width + 1 && value.innerWidth <= width + 1, 'Opening a menu does not widen the mobile layout');
      assert.equal(value.scrollX, 0); assert.equal(value.visualOffsetLeft, 0); assert.equal(value.visualOffsetTop, 0);
      return value;
    };
    await mobile.locator('#library-navigation-toggle').tap(); await idle(mobile);
    await expect(mobile.locator('#library-navigation-menu')).toBeVisible();
    const library = await geometry('#library-navigation-menu');
    await mobile.locator('#library-navigation-menu').getByRole('button', { name: 'Technical Library', exact: true }).tap();
    await expect(mobile.locator('#library-technical')).toBeVisible();
    await mobile.locator('#takeoff-navigation-toggle').tap(); await idle(mobile);
    await expect(mobile.locator('#takeoff-navigation-menu')).toBeVisible();
    const takeoffs = await geometry('#takeoff-navigation-menu');
    await mobile.locator('#penetration-navigation-toggle').tap();
    await expect(mobile.locator('#penetration-navigation-menu')).toBeVisible();
    const penetrations = await geometry('#takeoff-navigation-menu');
    await mobile.screenshot({ path: path.join(output, `touch-takeoff-menu-${width}.png`) });
    await mobile.locator('#penetration-navigation-menu').getByRole('button', { name: 'Service Plans', exact: true }).tap();
    await idle(mobile); await expect(mobile.locator('.takeoff-physical-register')).toBeVisible();
    await expect(mobile.locator('#takeoff-navigation-menu')).toBeHidden();
    assert.deepEqual(await mobile.evaluate(() => window.qaCsp), []);
    evidence.touch.push({ width, technicalLibraryToServicePlans: true, library, takeoffs, penetrations });
    await context.close();
  }
  await checkWorkspaceTabs(info);
  for(const [name,hash]of Object.entries(navigationHashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),hash,'Navigation production source stayed fixed: '+name);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, evidence, errors, csp: [] }, null, 2));
  console.log(`PASS: stacked navigation pointer paths, view selection, keyboard/touch and Home card cursors. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-4000));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output, 'server.log'), logs);
  if (browser) await browser.close(); server.kill();
});
