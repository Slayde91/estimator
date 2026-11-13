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

async function checkCalculatorLayouts(page,output) {
  const viewport = page.viewportSize(), grid = page.locator('#calculator-grid');
  const ready = () => expect(grid).toHaveAttribute('aria-busy','false');
  async function tab(label) { await page.locator('#calculator-pages').getByRole('button',{name:label,exact:true}).click(); await ready(); }
  async function section(id) {
    const button = grid.locator('[data-calculator-settings-section="'+id+'"]');
    if (await button.getAttribute('aria-expanded')!=='true') await button.click();
    return page.locator('#'+await button.getAttribute('aria-controls'));
  }
  async function heading(el) {
    await expect(el).toBeVisible();
    await expect(el).toHaveCSS('background-color','rgb(185, 10, 21)');
    await expect(el).toHaveCSS('color','rgb(255, 255, 255)');
    await expect(el).toHaveCSS('border-radius','8px');
  }
  const snapshot=()=>page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  const before=await snapshot();
  await page.setViewportSize({width:1440,height:980});
  for (const calculator of ['Steel (spray)','Steel (intumescent)']) {
    await chooseCalculator(page,calculator); await tab('SCHEDULE'); await heading(grid.locator('.calculator-schedule-section > h4'));
    await tab('SETTINGS');
    for (const button of await grid.locator('[data-calculator-settings-section]').all()) {
      await checkFields(await section(await button.getAttribute('data-calculator-settings-section')));
    }
  }
  for (const calculator of ['Steel (board)','Duct']) {
    await chooseCalculator(page,calculator); await tab('SCHEDULE'); await heading(grid.locator('.calculator-overview-title').first());
  }
  await tab('SUMMARY'); await heading(grid.locator('.calculator-role-compact_summary_title').first());
  await tab('PRODUCT SETTINGS');
  for (const id of ['A6','A48','A94']) {
    const panel=await section(id);
    if(id==='A94') for(const title of ['FYREWRAP ELITE 1.5','FYREWRAP APPLICATION TABLE']) await heading(panel.getByRole('heading',{name:title,exact:true}));
    else await heading(panel.locator('.calculator-section-anchor').first());
    await checkFields(panel);
    if(id==='A6') await screenshot(page,panel,path.join(output,'duct-settings-layout.png'));
  }
  await chooseCalculator(page,'Factor Calcs'); await ready();
  for(const id of ['A341','A356']) {
    const panel=await section(id);await heading(panel.locator('.calculator-section-anchor').first());await checkFields(panel);
    if(id==='A356') {
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
  await page.setViewportSize(viewport);
}
module.exports={checkCalculatorLayouts};
