const {expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const icons=require('./preview_header_icons.json');
const views=['home','contacts','projects','documents','estimate','calculators','takeoffs','pricing','scheduler','help','settings'];
const originalViews=['home','estimate','calculators','takeoffs','pricing','projects','help','settings'];
async function assertPreviewHeaderIcons(page){
  await expect(page.locator('nav[aria-label="Main navigation"] .nav-icon')).toHaveCount(11);
  assert.deepEqual(await page.locator('nav[aria-label="Main navigation"] .nav-icon').evaluateAll(nodes=>nodes.map(node=>node.dataset.view)),views);
  for(const view of views){
    const index=originalViews.indexOf(view);
    const button=page.locator(`nav [data-view="${view}"]`),svg=button.locator('svg');
    await expect(button).toHaveAccessibleName(index<0?view[0].toUpperCase()+view.slice(1):icons[index].label);
    await expect(svg).toHaveCount(1);await expect(button.locator('img')).toHaveCount(0);
    await expect(svg).toHaveAttribute('viewBox','0 0 24 24');
    await expect(svg).toHaveAttribute('stroke-width','2');
    await expect(svg).toHaveAttribute('aria-hidden','true');
    await expect(svg).toHaveAttribute('focusable','false');
    if(index>=0)assert.equal(await svg.innerHTML(),icons[index].svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1],`${view} retains the captured preview paths`);
  }
}
module.exports={assertPreviewHeaderIcons,views};
