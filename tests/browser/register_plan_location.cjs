const path = require('node:path');
const {expect} = require('@playwright/test');
const {chooseTakeoff} = require('./section_navigation.cjs');

async function pinDrawing(page, reopenRegister, directory) {
  await chooseTakeoff(page, 'Defect Reports');
  await page.locator('#takeoff-upload').setInputFiles(path.join(directory,'Register plans.pdf'));
  await expect(page.locator('.takeoff-document')).toHaveCount(1,{timeout:60000});
  await expect.poll(() => page.evaluate(() => {
    try { return window.CeasefireTakeoffs.projectSnapshot()?.render_checks?.some(check => check.page===1 && check.success); }
    catch { return false; } // An upload in progress has no settled snapshot yet.
  }),{timeout:60000}).toBe(true);
  await reopenRegister();
  const plan = page.locator('.register-plan-location');
  const choices = plan.locator('[name=plan_source]');
  const drawing = choices.locator('option').filter({hasText:'Register plans.pdf'});
  await expect(drawing).toHaveCount(1);
  await choices.selectOption(await drawing.getAttribute('value'));
  await plan.locator('[name=plan_page]').selectOption('3');
  const sheet = plan.locator('.register-plan-sheet');
  await expect(sheet).toBeEnabled({timeout:30000});
  const box = await sheet.boundingBox();
  await sheet.click({position:{x:Math.round(box.width*.42),y:Math.round(box.height*.45)}});
  await expect(plan.locator('.register-plan-mark').first()).toBeVisible();
  await expect(plan.locator('.register-plan-pins')).toContainText('001');
}
module.exports = {pinDrawing};
