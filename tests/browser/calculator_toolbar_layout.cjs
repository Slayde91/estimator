const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');

async function checkAllowances(page, fields, output, screenshotName) {
  const section = fields.locator('.penetration-settings-section').first();
  const heading = section.getByRole('heading', {name:'Waste & Allowances', exact:true});
  const routing = fields.getByRole('heading', {name:'SERVICE-TAB ROUTING', exact:true});
  await expect(heading).toBeVisible();
  await expect(section.locator('h4 + .table-scroll table')).toBeVisible();
  await expect(section.getByRole('rowheader', {name:'Labour allowances', exact:true})).toBeVisible();
  for (const property of ['background-color','color','padding','border-radius','font-size','font-weight','text-transform']) {
    await expect(heading).toHaveCSS(property, await routing.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key), property));
  }
  await heading.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
  await page.screenshot({path:path.join(output,screenshotName)});
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('fr',false));
  await expect(section.getByRole('heading')).toHaveText('Pertes et provisions');
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
}

async function checkWorkbookControls(page, factor) {
  const pages = page.locator('#calculator-pages button:visible');
  const choices = page.locator('#calculator-grid .calculator-settings-choice:visible');
  const actions = page.locator('#calculator-toolbar-actions')
    .locator('.schedule-column-toggle:visible,#calculator-document-toggle:visible,#calculator-reset:visible,#calculator-recalculate:visible');
  if (factor) {
    await expect(pages).toHaveCount(0);
    await expect(choices).toHaveCount(2);
  } else {
    assert.ok(await pages.count() > 0);
  }
  assert.ok(await actions.count() >= 2);
  for (const group of [factor ? choices : pages, actions]) {
    for (const control of await group.all()) {
      const box = await control.boundingBox();
      assert.equal(box.height, 42, await control.evaluate(el => el.id || el.textContent));
    }
  }
}

async function checkToolbar(page, width, output) {
  const toolbar = page.locator('.calculator-workspace-toolbar');
  const controls = toolbar.locator('.schedule-column-toggle,#calculator-document-toggle,#calculator-reset,#calculator-recalculate');
  await expect(controls).toHaveCount(4);
  const metrics = await controls.evaluateAll(items => items.map(el => {
    const bar = el.closest('.calculator-workspace-toolbar').getBoundingClientRect();
    const rect = el.getBoundingClientRect(), pic = el.querySelector('img,svg')?.getBoundingClientRect();
    return {name:el.id||el.className, height:rect.height, top:rect.top-bar.top, bottom:bar.bottom-rect.bottom,
      iconOffset:pic ? (pic.top + pic.height/2) - (rect.top+rect.height/2) : 0};
  }));
  for(const metric of metrics){
    assert.equal(metric.height,42,JSON.stringify(metric));
    assert.ok(metric.top>=4 && metric.bottom>=4,JSON.stringify(metric));
    if(width>760)assert.ok(Math.abs(metric.bottom-metric.top)<=1,JSON.stringify(metric));
    assert.ok(Math.abs(metric.iconOffset)<=1,JSON.stringify(metric));
  }
  await toolbar.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
  await page.screenshot({path:path.join(output,`calculator-toolbar-${width}.png`)});
  return metrics;
}

module.exports = {checkAllowances,checkToolbar,checkWorkbookControls};
