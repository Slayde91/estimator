const {expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const icons=require('./preview_header_icons.json');
const views=['home','estimate','calculators','takeoffs','pricing','quotes','help','settings'];
async function assertPreviewHeaderIcons(page){
  await expect(page.locator('nav[aria-label="Main navigation"] .nav-icon')).toHaveCount(8);
  for(const [index,view] of views.entries()){
    const button=page.locator(`nav [data-view="${view}"]`),svg=button.locator('svg');
    await expect(button).toHaveAccessibleName(icons[index].label);
    await expect(svg).toHaveCount(1);await expect(button.locator('img')).toHaveCount(0);
    await expect(svg).toHaveAttribute('viewBox','0 0 24 24');
    await expect(svg).toHaveAttribute('stroke-width','2');
    await expect(svg).toHaveAttribute('aria-hidden','true');
    await expect(svg).toHaveAttribute('focusable','false');
    assert.equal(await svg.innerHTML(),icons[index].svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1],`${view} uses the captured preview paths`);
  }
}
module.exports={assertPreviewHeaderIcons,views};
