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
  await expect(sheet).toBeVisible({timeout:30000});
  const canvas = sheet.getByRole('button',{name:'Place pin on plan'});
  const mark = sheet.getByRole('button',{name:'001',exact:true});
  const box = await canvas.boundingBox(), controls = await plan.locator('.register-plan-controls').boundingBox();
  expect(Math.abs(box.width - controls.width)).toBeLessThan(2);
  expect((await plan.getByLabel('Page number').boundingBox()).width).toBeLessThan(130);
  await canvas.click({position:{x:Math.round(box.width*.2),y:Math.round(box.height*.25)}});
  await expect(mark).toBeVisible();
  await canvas.click({force:true,position:{x:Math.round(box.width*.3),y:Math.round(box.height*.35)}});
  await expect(mark).toHaveCount(1);
  await plan.getByLabel('Page number').selectOption('1');
  await expect(sheet).toBeVisible();
  await expect(canvas).toBeDisabled();
  await plan.getByLabel('Page number').selectOption('3');
  await mark.click({button:'right'});
  await sheet.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(mark).toHaveCount(0);
  await canvas.click({position:{x:Math.round(box.width*.35),y:Math.round(box.height*.4)}});
  await mark.scrollIntoViewIfNeeded();
  const start = await mark.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + box.width*.07, start.y + start.height / 2 + box.height*.05,{steps:7});
  await page.mouse.up();
  await expect(sheet.getByRole('button',{name:'Delete',exact:true})).toHaveCount(0);
  await mark.focus();
  await mark.press('Shift+F10');
  await sheet.getByRole('button',{name:'Delete',exact:true}).press('Escape');
  await expect(mark).toBeFocused();
}
module.exports = {pinDrawing};
