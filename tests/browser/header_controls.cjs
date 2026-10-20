// Layout and guarded navigation use disposable fixtures, never the live project.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { chooseTakeoff, chooseLibrary } = require('./section_navigation.cjs');
const { assertPreviewHeaderIcons } = require('./preview_header_helpers.cjs');
const { checkPointerEffects } = require('./pointer_effects_checks.cjs');
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
      name = await box(page.locator('#header-project-name')), identity = await box(page.locator('.header-project-identity')), status = await box(page.locator('#project-save-state')), logo = await box(page.locator('.brand-logo')), tagline = await box(page.locator('#header-tagline'));
    assert.ok(nav.y >= header.y && nav.y + nav.height <= header.y + header.height + 1, `Navigation stays in the header at ${width}`);
    if (width > 1150) assert.ok(nav.x >= brand.x + brand.width, `Navigation sits to the right of the logo at ${width}`);
    assert.ok(actions.y > header.y + header.height && actions.y + actions.height <= 1000, `Project actions overlay the viewport bottom at ${width}`);
    assert.ok(actions.x + actions.width <= width + 1, `Project actions fit at ${width}`);
    assert.ok(name.x >= identity.x && name.x + name.width <= identity.x + identity.width + 1 && name.y>=nav.y+nav.height, `Long quote name stays beneath navigation in its own column at ${width}`);assert.ok(status.y>=name.y+name.height&&Math.abs(status.x+status.width-nav.x-nav.width)<1,'Save state remains beneath project name at the right');
    const compact=width<=720,logoWidth=Math.min(compact?(width<=420?100:130):250,brand.width);
    assert.ok(Math.abs(logo.width-logoWidth)<.1&&Math.abs(logo.height-logoWidth*(compact?1/3:83.8/250))<.1,'Logo retains the requested desktop box and original compact phone proportions');
    assert.ok(Math.abs(tagline.y-(logo.y+logo.height+(compact?4:6)-(compact?0:20)))<.1,'The requested desktop20px overlap keeps the normal4px phone gap');
    assert.ok(Math.abs(tagline.x-brand.x-(compact?0:15))<.1&&tagline.x+tagline.width<=brand.x+brand.width+.1,'The requested desktop15px inset stays within the brand; phone alignment is unchanged');
    const logoInk=await page.locator('.brand-logo').evaluate(img=>{
      // The PNG contains nearly transparent raster noise outside the mark.
      // Alpha>8 includes every visible letter/symbol and excludes that noise.
      const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const context=canvas.getContext('2d');context.drawImage(img,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let left=canvas.width,top=canvas.height,right=0,bottom=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
      const r=img.getBoundingClientRect(),style=getComputedStyle(img),scale=Math.min(r.width/canvas.width,r.height/canvas.height),position=style.objectPosition.split(' ').map(v=>parseFloat(v)/100),x=r.x+(r.width-canvas.width*scale)*position[0],y=r.y+(r.height-canvas.height*scale)*position[1];return{alphaThreshold:8,natural:[canvas.width,canvas.height],source:{left,top,right,bottom},fit:style.objectFit,rendered:{left:x+left*scale,top:y+top*scale,right:x+right*scale,bottom:y+bottom*scale}};
    });
    assert.equal(logoInk.fit,'contain');assert.ok(logoInk.source.right>logoInk.source.left&&logoInk.source.bottom>logoInk.source.top,'Actual supplied logo has visible artwork');
    assert.ok(tagline.y>=logoInk.rendered.bottom-.1,'The character/quote clears the actual logo ink while sharing its transparent canvas: '+JSON.stringify({width,logo,tagline,logoInk}));
    await expect(page.locator('#header-project-name')).toHaveText(longName);
    await expect(page.locator('#header-project-name')).toHaveAttribute('title', longName);
    assert.equal(await page.locator('#header-project-name').evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
    const buttons = await page.locator('nav[aria-label="Main navigation"] .nav-icon').evaluateAll(nodes => nodes.map(el => {
      const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
    }));
    assert.equal(buttons.length, 8);
    for (const b of buttons) {
      assert.ok(b.width >= 40 && b.height >= 40, `Usable navigation target at ${width}`);
      assert.ok(b.x >= nav.x && b.x + b.width <= nav.x + nav.width + 1 && b.y >= nav.y && b.y + b.height <= nav.y + nav.height + 1, `Individual navigation button fits at ${width}`);
    }
    const coordinates=await box(page.locator('#cursor-position'));
    assert.ok(coordinates.x>=header.x&&coordinates.x+coordinates.width<=header.x+header.width&&coordinates.y+coordinates.height<=header.y+header.height,'Coordinates remain inside the header');
    // The new coordinate row adds 16px plus the existing 4px identity gap.
    assert.ok(header.height <= (width > 1150 ? 180 : width > 720 ? 235 : 300)+20, `Header avoids excessive height at ${width}: ${header.height}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Long quote name does not cause overflow at ${width}`);
    const screenshot = path.join(output, `header-${width}-long-name.png`);
    await page.screenshot({ path: screenshot });
    evidence.headerGeometry.push({ width, header, brand, nav, actions, name, logo, tagline, logoInk, navigationRows: [...new Set(buttons.map(b => Math.round(b.y)))].length, screenshot });
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
  evidence.pointerEffects = await checkPointerEffects(page, output);
  const coordinates = page.locator('#cursor-position');
  await expect(coordinates).toBeVisible();
  await page.mouse.move(241, 173, { steps: 8 });
  await expect(coordinates).toHaveText('X241Y173');
  await page.mouse.move(501, 319, { steps: 8 });
  await expect(coordinates).toHaveText('X501Y319');
  await page.evaluate(() => scrollTo(0, 200));
  await page.mouse.move(310, 250);
  await expect(coordinates).toHaveText('X310Y250');
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(-10, -10);
  await expect(coordinates).toHaveText('—');
  evidence.cursorCoordinates = { realPointerMoves: true, windowPixelsAfterScroll: true, clearedOnLeave: true };
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await idle();
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']) {
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await expect(coordinates).toHaveCSS('color','rgb(255, 0, 0)');
    await page.locator('#theme-toggle').click();
  }
  // Compare fully initialized drafts, including the lazily loaded composer.
  await page.evaluate(async () => { await window.CeasefireCalculators.completeProjectSnapshot(); await window.CeasefirePenetrations.completeProjectSnapshot(); }); await idle();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  const initial = await snapshot();
  await expect(page.locator('#takeoff-navigation-menu > button, #takeoff-navigation-menu > .section-navigation-branch > button')).toHaveText(['Steel','Duct','Walls/Floors','Penetrations›']);
  await page.locator('#takeoff-navigation-toggle').focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
  await expect(page.locator('#penetration-navigation-toggle')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button',{name:'Defect Reports',exact:true})).toBeFocused();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('#calculators-heading,#libraries-heading,#takeoffs-heading,.library-choices,.takeoff-tab-panel,.takeoff-heading-controls')).toHaveCount(0);
  for (const width of [1600, 1146, 1021, 981, 825, 720, 570, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await inspectHeader(width);
    if (width > 1150) {
      const header=await box(page.locator('.app-header')),nav=await box(page.getByRole('navigation',{name:'Main navigation'}));
      assert.ok(nav.width<850,'Navigation includes visible page labels without filling the header');
      assert.ok(header.x+header.width-nav.x-nav.width<=32,'Main navigation is aligned at the far right');
    }
    if (width === 1146) {
      await page.locator('#takeoff-navigation-toggle').hover(); await page.locator('#penetration-navigation-toggle').hover();
      const parent=await box(page.locator('#penetration-navigation-toggle')), submenu=page.getByRole('group',{name:'Penetration workspaces'});await expect(submenu).toBeVisible();const bounds=await box(submenu);
      assert.ok(bounds.x >= 0 && bounds.x+bounds.width <= width && (bounds.x+bounds.width <= parent.x+1 || bounds.x >= parent.x+parent.width-1), 'Penetrations flyout remains beside its parent within the viewport');
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
      await page.keyboard.press('End'); await expect(id === 'takeoff' ? page.locator('#penetration-navigation-toggle') : id === 'calculator' ? page.locator('#steel-calculator-navigation-toggle') : menu.getByRole('button').last()).toBeFocused();
      if(id === 'calculator') {
        await page.keyboard.press('ArrowRight');await expect(page.locator('#steel-calculator-navigation-menu').getByRole('button',{name:'Steel (spray)',exact:true})).toBeFocused();
        await page.keyboard.press('End');await expect(page.locator('#steel-calculator-navigation-menu').getByRole('button',{name:'Steel (board)',exact:true})).toBeFocused();
      }
      if(id === 'takeoff') {
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('button',{name:'Defect Reports',exact:true})).toBeFocused();
        await page.keyboard.press('End');
        await expect(page.getByRole('button',{name:'Service Plans',exact:true})).toBeFocused();
      }
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
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y > header.y + header.height && bounds.y + bounds.height <= 1000);
      assert.equal(await actions.evaluate(el=>getComputedStyle(el).position),'fixed');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}/${section}`);
      if (section === 'Projects') {
        const controls = page.locator('.project-workspace-actions'), link = await box(controls.getByRole('button', { name: 'Link Project Folder', exact: true }));
        for (const name of ['New', 'Load']) { const b = await box(controls.getByRole('button', { name, exact: true })); assert.ok(b.height >= link.height); }
      } else for (const name of ['New', 'Load']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    evidence.widths.push(width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const title of ['Steel (spray)', 'Steel (board)', 'Duct']) {
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
  await assertPreviewHeaderIcons(page);
  await expect(page.getByRole('button',{name:'Save As',exact:true})).toHaveCount(0);
  await expect(page.locator('#project-attachment-zone')).toHaveAttribute('title','Drag or drop files');
  const icons=await page.locator('nav[aria-label="Main navigation"] .nav-icon>svg, nav[aria-label="Main navigation"] .nav-icon>span[aria-hidden]>svg, nav[aria-label="Main navigation"] .nav-icon>img').evaluateAll(nodes=>nodes.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,src:el.getAttribute('src'),stroke:el.tagName.toLowerCase()==='svg'?el.getAttribute('stroke-width'):null})));
  assert.equal(icons.length,8);for(const icon of icons){assert.ok(Math.abs(icon.width-26*(.65*1.2))<.02&&Math.abs(icon.height-26*(.65*1.2))<.02,'Original navigation artwork renders20% larger than the previous65% baseline');assert.equal(icon.stroke,'2');}
  await chooseCalculator(page,'Firestopping'); await idle();
  await expect(page.locator('#penetration-new-item')).toBeHidden(); await expect(page.locator('#penetration-recalculate')).toBeHidden();
  for (const [id, name] of [['penetration-clear','Clear'],['penetration-add-to-schedule','Add to Schedule'],['penetration-add-to-library','Add to Library']]) { await expect(page.locator('#'+id)).toBeVisible(); await expect(page.locator('#'+id)).toHaveAccessibleName(name); }
  const penetrationBanner=page.locator('#penetration-current-item-card > .penetration-banner-heading'),headingActions=penetrationBanner.locator(':scope > .penetration-heading-actions'),currentItem=page.locator('#penetration-current-item-card > .penetration-item-heading');
  for(const id of ['penetration-clear','penetration-add-to-library'])await expect(headingActions.locator('#'+id)).toHaveCount(1);
  const penetrationDocument=headingActions.getByRole('button',{name:'Document',exact:true});await expect(penetrationDocument).toHaveCount(1);
  await expect(headingActions.locator('#penetration-add-to-schedule')).toHaveCount(0);await expect(currentItem.locator('#penetration-add-to-schedule')).toBeVisible();
  const firestoppingWidths=[];
  for(const width of [1440,825,390]){
    await page.setViewportSize({width,height:1000});
    const clear=await box(headingActions.locator('#penetration-clear')),document=await box(penetrationDocument),library=await box(headingActions.locator('#penetration-add-to-library')),banner=await box(penetrationBanner),item=await box(currentItem),add=await box(currentItem.locator('#penetration-add-to-schedule'));
    assert.ok(clear.x+clear.width<=document.x&&document.x+document.width<=library.x&&Math.abs(clear.y-document.y)<1&&Math.abs(document.y-library.y)<1,'Clear, Document and Library stay ordered on the same first row at '+width);
    assert.ok(Math.abs(clear.height-document.height)<1&&Math.abs(document.height-library.height)<1&&Math.abs(add.height-library.height)<1,'Firestopping action buttons retain equal heights at '+width);
    assert.ok(clear.x>=banner.x&&library.x+library.width<=banner.x+banner.width+1&&clear.y>=banner.y&&library.y+library.height<=banner.y+banner.height+1&&library.y+library.height<=item.y,'The first-row actions fit within the banner above current-item controls at '+width);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Firestopping header fits the viewport at '+width);firestoppingWidths.push(width);
  }
  await page.setViewportSize({width:1440,height:1000});
  evidence.firestoppingCurrentActions={topNewAndRecalculateHidden:true,visibleAccessibleActions:true,clearDocumentLibraryInBanner:true,scheduleWithCurrentItem:true,widths:firestoppingWidths};
  for (const kind of ['pricing', 'penetration', 'technical']) {
    await chooseLibrary(page, kind); await expect(page.locator(`#library-${kind}`)).toBeVisible();
    if(kind==='pricing'){
      await expect(page.locator('#pricing-heading')).toHaveText('Pricing Library');await expect(page.locator('#pricing-heading')).toHaveCSS('font-size','28px');
      await expect(page.locator('#library-pricing .eyebrow')).toHaveCount(0);
      assert.ok(await page.locator('#library-pricing .table-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Pricing columns fit desktop width');
    }
    if(kind==='technical')await expect(page.locator('[data-library-summary="technical"]')).toBeVisible();
    if(kind==='pricing')await expect(page.locator('#library-pricing > .page-heading .subtitle')).toHaveCount(0);
    else {
      const heading=page.locator(`#library-${kind} > .page-heading`), image=heading.locator('.library-heading-art-slot img');
      await expect(image).toHaveAttribute('src',`/header-${kind==='penetration'?'firestopping':'technical'}-library.png`);
      assert.ok(await image.evaluate(el=>el.complete&&el.naturalWidth>0));
      for(const width of [1384,825,390]) {
        await page.setViewportSize({width,height:1000});
        const bounds=await heading.boundingBox(), art=await image.boundingBox(), title=await heading.locator('h1,h2').boundingBox();
        assert.ok(art.x>=title.x+title.width&&art.x+art.width<=bounds.x+bounds.width+1,'Library artwork sits beside the heading without overlap');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:path.join(output,`library-${kind}-${width}.png`)});
      }
      await page.setViewportSize({width:1440,height:1000});
    }
    evidence.libraries.push(kind);
  }
  for (const name of ['Steel', 'Duct', 'Walls/Floors', 'Defect Reports', 'Service Plans']) {
    await chooseTakeoff(page, name); await idle();
    const visibility=page.getByRole('button',{name:'Visibility',exact:true});await expect(visibility).toBeVisible();assert.ok(await visibility.locator('img').evaluate(img=>img.complete && img.naturalWidth>0));
    await expect(page.locator('.takeoff-workspace-title')).toHaveText(name);
    const reference=await page.locator('#view-takeoffs').getByRole('button', { name: 'Settings', exact: true }).boundingBox();
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
  assert.match(await mobile.locator('#takeoff-navigation-toggle').evaluate(el=>getComputedStyle(el).cursor),/laser-reticle\.svg/,'Reticle remains available to a mouse in browsers reporting touch hardware');
  for (const [id, choice, view] of [['library', 'Technical Library', '#library-technical'], ['takeoff', 'Service Plans', '.takeoff-physical-register']]) {
    await mobile.locator(`#${id}-navigation-toggle`).tap(); await idle(mobile); const menu = mobile.locator(`#${id}-navigation-menu`); await expect(menu).toBeVisible();
    if (id === 'takeoff') await mobile.locator('#penetration-navigation-toggle').tap();
    await menu.getByRole('button', { name: choice, exact: true }).tap(); await expect(mobile.locator(view)).toBeVisible(); await expect(menu).toBeHidden();
  }
  evidence.touch = true; await touch.close(); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, assetHashes, evidence, errors }, null, 2)); console.log(`PASS header controls: ${output}`);
})().catch(async e => { console.error(e); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
