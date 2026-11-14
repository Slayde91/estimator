const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');

async function checkFields(panel) {
  const fields = await panel.locator('.calculator-settings-fields :is(select,input):visible').evaluateAll(els => els.map(el => {
    const css = getComputedStyle(el), ctx = document.createElement('canvas').getContext('2d');
    ctx.font = css.font;
    const measure = text => ctx.measureText(text).width + Math.max(0, text.length-1) * (parseFloat(css.letterSpacing)||0);
    const isSelect = el.tagName === 'SELECT';
    const text = isSelect ? Math.max(...Array.from(el.options, o => measure(o.label))) : measure(el.value);
    const padding = ['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'].reduce((n,key)=>n+parseFloat(css[key]),0);
    return { address:el.dataset.calculatorCell, width:el.getBoundingClientRect().width, text, isSelect, padding, min:parseFloat(css.minWidth) };
  }));
  for (const f of fields) {
    assert.ok(f.width + 2 >= f.text + f.padding, JSON.stringify(f));
    assert.ok(f.width <= Math.max(f.min, f.text + f.padding + (f.isSelect ? 32 : 4)) + 3, JSON.stringify(f));
  }
}

async function screenshot(page,panel,filename) {
  const clip = await panel.evaluate(el => {
    el.scrollIntoView({block:'start',behavior:'instant'});
    window.scrollBy({top:el.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom - 12,behavior:'instant'});
    const r=el.getBoundingClientRect(), x=Math.max(0,Math.floor(r.x)), y=Math.max(0,Math.floor(r.y));
    return {x,y,width:Math.min(innerWidth-x,Math.floor(r.width)),height:Math.min(innerHeight-y,Math.floor(r.height))};
  });
  await page.screenshot({path:filename,clip});
}

async function checkFieldGroup(page, panel, addresses, reference, output, name) {
  const previous = page.viewportSize();
  const fields = panel.locator(addresses.map(a => '[data-calculator-cell="' + a + '"]').join(','));
  await expect(fields).toHaveCount(addresses.length);
  async function measure() {
    return fields.evaluateAll((controls, ref) => {
      const width = controls.find(el => el.dataset.calculatorCell === ref)?.getBoundingClientRect().width;
      return controls.map(el => {
        const box = el.getBoundingClientRect(), cell = el.closest('td'), css = getComputedStyle(cell);
        const left = cell.getBoundingClientRect().left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft) - cell.scrollLeft;
        return { address:el.dataset.calculatorCell, x:box.left-left, delta:width ? box.width-width : 0 };
      });
    }, reference);
  }
  for (const width of [913,1915]) {
    await page.setViewportSize({width,height:884});
    await expect.poll(async () => (await measure()).filter(v => Math.abs(v.x)>1 || Math.abs(v.delta)>1)).toEqual([]);
    if (width===1915 || reference==='D358') await screenshot(page,panel,path.join(output,name+'-'+width+'.png'));
  }
  if (reference) {
    const source = panel.locator('[data-calculator-cell="'+reference+'"]');
    await source.evaluate(el => {const opt=new Option('Saved value: historical workbook option with a longer description','historical-width-test');opt.disabled=true;el.add(opt);});
    await expect.poll(async () => (await measure()).filter(v => Math.abs(v.delta)>1)).toEqual([]);
    await source.evaluate(el=>el.options[el.options.length-1].remove());
    await expect.poll(async () => (await measure()).filter(v => Math.abs(v.delta)>1)).toEqual([]);
  }
  await page.setViewportSize(previous);
}

async function checkCalculatorLayouts(page,output) {
  const viewport = page.viewportSize(), grid = page.locator('#calculator-grid');
  const ready = () => expect(grid).toHaveAttribute('aria-busy','false');
  async function tab(label) { await page.locator('#calculator-pages').getByRole('button',{name:label,exact:true}).click(); await ready(); }
  async function section(id) {
    const button = page.locator('#calculator-workspace [data-calculator-settings-section="'+id+'"]');
    if (await button.getAttribute('aria-expanded')!=='true') await button.click();
    return page.locator('#'+await button.getAttribute('aria-controls'));
  }
  async function heading(el) {
    await expect(el).toBeVisible();
    await expect(el).toHaveCSS('background-color','rgb(185, 10, 21)');
    await expect(el).toHaveCSS('color','rgb(255, 255, 255)');
    await expect(el).toHaveCSS('border-bottom','4px solid rgb(255, 255, 255)');
    await expect(el).toHaveCSS('border-radius','8px');
  }
  async function titleSize(title) {
    await expect(title).toHaveCSS('font-size','14px');
    await expect(title).toHaveCSS('border-radius','8px');
    assert.equal(await title.evaluate(el => el.getBoundingClientRect().height),56);
  }
  async function columnHeadings(headers) {
    await expect(headers.first()).toBeVisible();
    const previous=page.viewportSize();
    for (const width of [1254,390]) {
      await page.setViewportSize({width,height:884});
      const invalid=await headers.evaluateAll(nodes => nodes.flatMap(cell => {
        const box=cell.getBoundingClientRect(), range=new Range();
        range.selectNodeContents(cell);
        const clipped=[...range.getClientRects()].some(text => text.left<box.left-1 || text.right>box.right+1 || text.top<box.top-1 || text.bottom>box.bottom+1);
        return box.height===45 && getComputedStyle(cell).fontSize==='12px' && !clipped
          ? [] : [{label:cell.textContent,height:box.height,clipped}];
      }));
      assert.deepEqual(invalid,[],`Schedule headings at ${width}px`);
    }
    await page.setViewportSize(previous);
  }
  const snapshot=()=>page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  const before=await snapshot();
  await page.setViewportSize({width:1440,height:980});
  for (const calculator of ['Steel (spray)','Steel (intumescent)']) {
    await chooseCalculator(page,calculator); await expect(page.locator('#calculator-title')).toHaveText(calculator);
    await tab('SCHEDULE'); await heading(grid.locator('.calculator-schedule-section > h4'));
    await titleSize(grid.locator('.calculator-schedule-section > h4'));
    await columnHeadings(grid.locator('.calculator-schedule-table thead th:visible'));
    await tab('SUMMARY');
    await columnHeadings(grid.locator('.calculator-product-totals thead th:visible'));
    if (calculator === 'Steel (spray)') {
      await heading(grid.locator('#calculator-product-totals > h4'));
      await heading(grid.locator('#calculator-table-section-steel_vermiculite-BAGS-0'));
      await screenshot(page,grid,path.join(output,'steel-spray-summary-headings.png'));
    }
    await tab('SETTINGS');
    if (calculator === 'Steel (intumescent)') await titleSize(grid.locator('.calculator-settings-fields .calculator-role-title.calculator-merged:visible').first());
    for (const button of await grid.locator('[data-calculator-settings-section]').all()) {
      const id = await button.getAttribute('data-calculator-settings-section'), panel = await section(id);
      if (calculator === 'Steel (spray)' && ['A64','A96','A173','A229','A559'].includes(id))
        await heading(panel.locator('#calculator-section-steel_vermiculite-SETTINGS-'+id));
      await checkFields(panel);
      if(calculator==='Steel (spray)' && id==='A9') await checkFieldGroup(page,panel,['D13','D14'],'D14',output,'global-values');
    }
  }
  for (const calculator of ['Steel (board)','Duct']) {
    await chooseCalculator(page,calculator); await expect(page.locator('#calculator-title')).toHaveText(calculator);
    await tab('SCHEDULE'); await heading(grid.locator('.calculator-overview-title').first());
    if (calculator==='Steel (board)') await titleSize(grid.locator('.calculator-overview-title').first());
    await columnHeadings(grid.locator('.calculator-schedule-table thead th:visible'));
    await tab(calculator==='Steel (board)'?'BOARD SUMMARY':'SUMMARY');
    await columnHeadings(grid.locator('.calculator-projection-table tr:first-child:has(> .calculator-role-column_header) > th:visible'));
  }
  await tab('SUMMARY'); await heading(grid.locator('.calculator-role-compact_summary_title').first());
  await tab('PRODUCT SETTINGS');
  for (const id of ['A6','A48','A94']) {
    const panel=await section(id);
    if(id==='A94') {
      const title=panel.getByRole('heading',{name:'FYREWRAP ELITE 1.5',exact:true});
      await heading(title);await expect(title).toHaveCSS('height','56px');await expect(title).toHaveCSS('font-size','14px');
      await heading(panel.getByRole('heading',{name:'FYREWRAP APPLICATION TABLE',exact:true}));
    }
    else await heading(panel.locator('.calculator-section-anchor').first());
    await checkFields(panel);
    if(id==='A6') await screenshot(page,panel,path.join(output,'duct-settings-layout.png'));
    if (id==='A6') await checkFieldGroup(page,panel,['B35','B44','B45','B46','B161','B162'],'B35',output,'cafco-values');
    if (id==='A48') await checkFieldGroup(page,panel,['B65','B73','B90','B91','B92','B163','B164'],'B73',output,'monokote-values');
    if (id==='A94') await checkFieldGroup(page,panel,['B96','B97','B98','B99','B100','B111'],null,output,'fyrewrap-values');
  }
  await chooseCalculator(page,'Factor Calcs'); await ready();
  for(const id of ['A341','A356']) {
    const panel=await section(id);await heading(panel.locator('.calculator-section-anchor').first());await checkFields(panel);
    await expect(panel.locator('tr:has(> .calculator-section-anchor) + tr > td:visible').first()).toHaveCSS('border-top-width','8px');
    if(id==='A341') await expect(panel.locator('[data-calculator-output="A343"]')).toHaveCount(0);
    if(id==='A356') {
      await checkFieldGroup(page,panel,['D358','D359','D360','D361','D362'],'D358',output,'hollow-values');
      const select=panel.locator('select:visible').first(),input=panel.locator('input.calculator-number:visible').first();
      // Probe a historical option and full numeric precision without changing the stored draft.
      assert.ok(await select.evaluate(el=>{
        const width=el.getBoundingClientRect().width;
        const option=new Option('Saved value: a historical worksheet option longer than any current label (choose a listed value)','historical');
        option.disabled=true;el.append(option);const grew=el.getBoundingClientRect().width>width+150;option.remove();return grew;
      }));
      await input.focus();const original=await input.inputValue();
      assert.ok(await input.evaluate(el=>{
        const saved=el.value,width=el.getBoundingClientRect().width;el.value='0.123456789012345';
        const grew=el.getBoundingClientRect().width>width;el.value=saved;return grew;
      }));
      await expect(input).toBeFocused();await expect(input).toHaveValue(original);await input.press('Tab');
      await page.setViewportSize({width:390,height:844});await checkFields(panel);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await screenshot(page,panel,path.join(output,'factor-settings-mobile.png'));
      await page.setViewportSize({width:1440,height:980});await screenshot(page,panel,path.join(output,'factor-settings-layout.png'));
    }
  }
  assert.deepEqual(await snapshot(),before);
  await chooseCalculator(page,'Firestopping');
  await columnHeadings(page.locator('#penetration-schedule-panel-schedule thead th:visible'));
  await page.setViewportSize(viewport);
}
module.exports={checkCalculatorLayouts};
