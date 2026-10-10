// Layout and guarded navigation use disposable fixtures, never the live project.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { chooseTakeoff, chooseLibrary } = require('./section_navigation.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `header-controls-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const assets = ['static/index.html', 'static/app.js', 'static/styles.css', 'static/calculators.css', 'static/takeoffs.js', 'static/takeoff-physical.js'];
const assetHashes = Object.fromEntries(assets.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let data = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { data += value; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
});
const errors = [], evidence = { widths: [], headerOnlyWidths: [320], headerGeometry: [], calculators: [], libraries: [], takeoffs: [] };
async function idle(target = page) { await target.waitForFunction(() => { const s = window.CeasefireDesktop?.status(); return s?.ready && !s.busy; }); }
async function snapshot() { await idle(); return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), takeoffs: window.CeasefireTakeoffs.projectSnapshot() })); }
const box = locator => locator.boundingBox();
async function inspectHeader(width) {
  const longName = 'CEASEFIRE saved quote — a very long project name with <literal markup> and an unbroken reference ' + 'Q'.repeat(180);
  const saved = await page.locator('#header-project-name').evaluate((el, name) => {
    const before = { text: el.textContent, title: el.title, hidden: el.hidden };
    el.textContent = name; el.title = name; el.hidden = false;
    return before;
  }, longName);
  try {
    const header = await box(page.locator('.app-header')), brand = await box(page.locator('.brand-stack')),
      nav = await box(page.getByRole('navigation', { name: 'Main navigation' })), actions = await box(page.locator('#header-project-actions')),
      name = await box(page.locator('#header-project-name'));
    assert.ok(Math.abs(nav.y - brand.y) < 1, `Navigation remains top-aligned at ${width}`);
    assert.ok(nav.x >= brand.x + brand.width && nav.x + nav.width <= actions.x + 1, `Navigation stays beside the logo at ${width}`);
    assert.ok(actions.x + actions.width <= width + 1, `Project actions fit at ${width}`);
    assert.ok(name.x >= brand.x && name.x + name.width <= brand.x + brand.width + 1, `Long quote name stays in its column at ${width}`);
    await expect(page.locator('#header-project-name')).toHaveText(longName);
    await expect(page.locator('#header-project-name')).toHaveAttribute('title', longName);
    assert.equal(await page.locator('#header-project-name').evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
    const buttons = await page.locator('nav[aria-label="Main navigation"] .nav-icon').evaluateAll(nodes => nodes.map(el => {
      const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
    }));
    assert.equal(buttons.length, 7);
    for (const b of buttons) {
      assert.ok(b.width >= 40 && b.height >= 40, `Usable navigation target at ${width}`);
      assert.ok(b.x >= nav.x && b.x + b.width <= nav.x + nav.width + 1 && b.y >= nav.y && b.y + b.height <= nav.y + nav.height + 1, `Individual navigation button fits at ${width}`);
    }
    assert.ok(header.height <= (width >= 825 ? 180 : width >= 570 ? 235 : width >= 390 ? 260 : 300), `Header avoids excessive height at ${width}: ${header.height}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Long quote name does not cause overflow at ${width}`);
    const screenshot = path.join(output, `header-${width}-long-name.png`);
    await page.screenshot({ path: screenshot });
    evidence.headerGeometry.push({ width, header, brand, nav, actions, name, navigationRows: [...new Set(buttons.map(b => Math.round(b.y)))].length, screenshot });
  } finally {
    await page.locator('#header-project-name').evaluate((el, before) => { el.textContent = before.text; el.title = before.title; el.hidden = before.hidden; }, saved);
  }
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(60000); page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', e => window.qaCsp.push(e.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle(); await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#header-project-name')).toBeHidden();
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  const initial = await snapshot();
  await expect(page.locator('#calculators-heading,#libraries-heading,#takeoffs-heading,.library-choices,.takeoff-tab-panel,.takeoff-heading-controls')).toHaveCount(0);
  for (const width of [1600, 1146, 1021, 981, 825, 720, 570, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await inspectHeader(width);
    if (width >= 1146) {
      const brand=await box(page.locator('.brand-stack')), nav=await box(page.getByRole('navigation',{name:'Main navigation'})), actions=await box(page.locator('#header-project-actions'));
      assert.ok(nav.width<550,'Navigation shrinks to its buttons');
      assert.ok(Math.abs(nav.y+nav.height/2-actions.y-actions.height/2)<2,'Save and project files share the navigation row');
      assert.ok(nav.x >= brand.x+brand.width && nav.x+nav.width <= actions.x && nav.y < brand.y+brand.height, 'Main navigation fits between the logo and Save controls');
    }
    if (width === 1146) {
      await page.locator('#takeoff-navigation-toggle').hover(); await page.locator('#penetration-navigation-toggle').hover();
      const parent=await box(page.locator('#penetration-navigation-toggle')), submenu=page.getByRole('group',{name:'Penetration workspaces'});await expect(submenu).toBeVisible();const bounds=await box(submenu);
      assert.ok(bounds.x >= parent.x+parent.width-1 && bounds.x+bounds.width <= width, 'Penetrations flyout opens to the right');
      await page.mouse.move(0,0);
    }
    for (const id of ['estimate', 'calculator', 'library', 'takeoff']) {
      const toggle = page.locator(`#${id}-navigation-toggle`), menu = page.locator(`#${id}-navigation-menu`);
      await toggle.hover(); await expect(menu).toBeVisible();
      const bounds = await box(menu); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${id} menu escaped ${width}: ${JSON.stringify(bounds)}`);
      if (id !== 'calculator') await expect(page.locator('#calculator-navigation-menu')).toBeHidden();
      if (id === 'takeoff') {
        await page.locator('#penetration-navigation-toggle').hover();
        const submenu = page.getByRole('group', { name: 'Penetration workspaces' });
        await expect(submenu).toBeVisible(); const subBounds = await box(submenu);
        assert.ok(subBounds.x >= -1 && subBounds.x + subBounds.width <= width + 1, `Penetration submenu fits ${width}`);
        await toggle.hover();
      }
      await toggle.focus(); await toggle.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('End'); await expect(menu.getByRole('button').last()).toBeFocused();
      await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(menu).toBeHidden();
    }
    // The additional 320px case covers this header change; retained whole-workspace coverage starts at 390px.
    if (width === 320) continue;
    for (const section of ['Home', 'Estimates', 'Calculators', 'Takeoffs', 'Libraries', 'Projects', 'Help']) {
      await page.getByRole('button', { name: section, exact: true }).click(); await idle();
      const actions = page.locator('#header-project-actions'); await expect(actions).toBeVisible();
      for (const name of ['Save', 'Project files']) await expect(actions.getByRole('button', { name, exact: true })).toBeVisible();
      const bounds = await box(actions), header = await box(page.locator('.app-header'));
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y < header.y + header.height);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}/${section}`);
      if (section === 'Projects') {
        const controls = page.locator('.project-workspace-actions'), link = await box(controls.getByRole('button', { name: 'Link Project Folder', exact: true }));
        for (const name of ['New', 'Load']) { const b = await box(controls.getByRole('button', { name, exact: true })); assert.ok(b.height >= link.height); }
      } else for (const name of ['New', 'Load']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    evidence.widths.push(width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const title of ['Steel (spray)', 'Steel (board)', 'Ductwork (spray/wrap)']) {
    await chooseCalculator(page, title); await idle();
    await expect(page.locator('#calculator-title')).toHaveText(title, { timeout: 60000 });
    await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
    const heading = page.locator('.calculator-workspace-heading');
    for (const id of ['calculator-reset', 'calculator-recalculate']) await expect(heading.locator('#' + id)).toBeVisible();
    const documents = heading.getByRole('button', { name: 'Document', exact: true });
    await expect(documents).toHaveAttribute('aria-expanded', 'false');
    for (const id of ['calculator-import', 'calculator-excel', 'calculator-pdf', 'calculator-summary-pdf', 'calculator-template']) await expect(heading.locator('#' + id)).toBeHidden();
    await documents.click();
    for (const id of ['calculator-import', 'calculator-excel', 'calculator-pdf', 'calculator-summary-pdf', 'calculator-template']) await expect(heading.locator('#' + id)).toBeVisible();
    await documents.press('Escape');
    const schedule = await box(heading.locator('.calculator-tools')), primary = await box(heading.locator('.calculator-primary-actions'));
    assert.ok(schedule.x + schedule.width <= primary.x && Math.abs(schedule.y - primary.y) < 2);
    await expect(page.locator('#calculator-workspace > .calculator-tools')).toHaveCount(0);
    await page.screenshot({ path: path.join(output, `${title.includes('board') ? 'board' : title.startsWith('Steel') ? 'spray' : 'duct'}-header.png`) });
    evidence.calculators.push(title);
  }
  await chooseCalculator(page, 'Steel (board)');await idle();await page.locator('#calculator-navigation-toggle').click();await expect(page.locator('#calculator-title')).toHaveText('Steel (board)');
  for (const [id, source] of [['library','penetration-add-to-library'],['calculator','calculator-recalculate']]) {
    assert.equal(await page.locator(`#${id}-navigation-toggle svg`).getAttribute('viewBox'),await page.locator(`#${source} svg`).getAttribute('viewBox'));
    assert.equal(await page.locator(`#${id}-navigation-toggle svg`).innerHTML(),await page.locator(`#${source} svg`).innerHTML());
  }
  await expect(page.locator('#takeoff-navigation-toggle img')).toHaveAttribute('src','/icons/navigation-takeoffs.png');
  assert.ok(await page.locator('#takeoff-navigation-toggle img').evaluate(img=>img.complete&&img.naturalWidth>0));
  await expect(page.getByRole('button',{name:'Save As',exact:true})).toHaveCount(0);
  await expect(page.locator('#project-attachment-zone')).toHaveAttribute('title','Drag or drop files');
  const icons=await page.locator('nav[aria-label="Main navigation"] .nav-icon>svg, nav[aria-label="Main navigation"] .nav-icon>span[aria-hidden]>svg, nav[aria-label="Main navigation"] .nav-icon>img').evaluateAll(nodes=>nodes.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,stroke:el.tagName.toLowerCase()==='svg'?el.getAttribute('stroke-width'):null})));
  assert.equal(icons.length,7);for(const icon of icons){assert.equal(icon.width,25);assert.equal(icon.height,25);if(icon.stroke!==null)assert.equal(icon.stroke,'1.8');}
  await chooseCalculator(page,'Firestopping'); await idle();
  await expect(page.locator('#penetration-new-item')).toBeHidden(); await expect(page.locator('#penetration-recalculate')).toBeHidden();
  for (const [id, name] of [['penetration-clear','Clear'],['penetration-add-to-schedule','Add to Schedule'],['penetration-add-to-library','Add to Library']]) { await expect(page.locator('#'+id)).toBeVisible(); await expect(page.locator('#'+id)).toHaveAccessibleName(name); }
  const add=await box(page.locator('#penetration-add-to-schedule')),library=await box(page.locator('#penetration-add-to-library'));
  assert.ok(add.x+add.width<=library.x&&Math.abs(add.y-library.y)<1&&Math.abs(add.height-library.height)<1,'Library follows the current-item Schedule action on the same row');
  evidence.firestoppingCurrentActions={topNewAndRecalculateHidden:true,visibleAccessibleActions:true,libraryFollowsSchedule:true};
  for (const kind of ['pricing', 'penetration', 'technical']) {
    await chooseLibrary(page, kind); await expect(page.locator(`#library-${kind}`)).toBeVisible();
    if(kind==='pricing'){
      await expect(page.locator('#pricing-heading')).toHaveText('Pricing Library');
      await expect(page.locator('#library-pricing .eyebrow')).toHaveText('INVENTORY & RATES');
      assert.ok(await page.locator('#library-pricing .table-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Pricing columns fit desktop width');
    }
    if(kind==='technical')await expect(page.locator('[data-library-summary="technical"]')).toBeVisible();
    evidence.libraries.push(kind);
  }
  for (const name of ['Steel', 'Duct', 'Walls/Floors', 'Defect Reports', 'Service Plans']) {
    await chooseTakeoff(page, name); await idle();
    const visibility=page.getByRole('button',{name:'Visibility',exact:true});await expect(visibility).toBeVisible();assert.ok(await visibility.locator('img').evaluate(img=>img.complete && img.naturalWidth>0));
    await expect(page.locator('.takeoff-workspace-title')).toHaveText(name==='Duct'?'Ductwork':name);
    const reference=await page.getByRole('button',{name:'Settings',exact:true}).boundingBox();
    for(const tool of ['Visibility',...name==='Steel'?['Markups','Legend']:name==='Duct'?['Legend']:[]]){const b=await page.getByRole('button',{name:tool,exact:true}).boundingBox();assert.equal(b.width,reference.width);assert.equal(b.height,reference.height);}
    const documents=await page.locator('.takeoff-source-documents').boundingBox(),search=await page.locator('.takeoff-search-controls').boundingBox();assert.ok(documents.x<search.x||documents.y<search.y);await expect(page.locator('.takeoff-drawing-layout>.takeoff-source-documents')).toHaveCount(0);
    const register = page.locator(['Defect Reports', 'Service Plans'].includes(name) ? '.takeoff-physical-register' : '.takeoff-register').filter({ visible: true });
    for (const label of ['Download PDF', 'Export CSV', 'Export XLSX', 'Export draft CSV', 'Export draft XLSX']) await expect(register.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    await expect(page.locator('#takeoff-active-scale')).toBeVisible();
    evidence.takeoffs.push(name);
  }
  assert.deepEqual(await snapshot(), initial, 'Layout and workspace selection must retain the project drafts');
  await chooseLibrary(page, 'pricing');
  await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first(); await price.fill('987.65432'); await price.press('Tab');
  await expect(page.locator('#pricing-status')).toHaveText('Unsaved pricing changes');
  const guarded = await snapshot();
  for (const select of [() => chooseLibrary(page, 'technical'), () => chooseTakeoff(page, 'Steel', { waitForSelection: false })]) {
    await select(); const dialog = page.getByRole('dialog', { name: 'Unsaved Pricing Library', exact: true });
    await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#library-pricing')).toBeVisible(); assert.deepEqual(await snapshot(), guarded);
  }
  await chooseLibrary(page, 'technical'); await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.locator('#library-technical')).toBeVisible(); assert.deepEqual(await snapshot(), guarded);
  evidence.pricingGuard = true;
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); const mobile = await touch.newPage(); await mobile.goto(`http://127.0.0.1:${info.port}/`); await idle(mobile);
  for (const [id, choice, view] of [['library', 'Technical Library', '#library-technical'], ['takeoff', 'Service Plans', '.takeoff-physical-register']]) {
    await mobile.locator(`#${id}-navigation-toggle`).tap(); await idle(mobile); const menu = mobile.locator(`#${id}-navigation-menu`); await expect(menu).toBeVisible();
    if (id === 'takeoff') await mobile.locator('#penetration-navigation-toggle').tap();
    await menu.getByRole('button', { name: choice, exact: true }).tap(); await expect(mobile.locator(view)).toBeVisible(); await expect(menu).toBeHidden();
  }
  evidence.touch = true; await touch.close(); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, assetHashes, evidence, errors }, null, 2)); console.log(`PASS header controls: ${output}`);
})().catch(async e => { console.error(e); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
