const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { chooseTakeoff } = require('./section_navigation.cjs');

async function checkRegisterSplit(page) {
  const drawing = page.locator('.takeoff-drawing-layout');
  const pane = page.locator('#takeoff-register-pane');
  const position = pane.getByLabel('Register position', { exact: true });
  const handle = page.getByRole('separator', { name: 'Resize register' });
  const width = async () => Math.round((await pane.boundingBox()).width);
  await page.setViewportSize({width:1384,height:900});
  for (const name of ['Walls/Floors','Defect Reports','Service Plans']) {
    await chooseTakeoff(page, name);
    await expect(position).toBeVisible();
    await expect(position).toHaveValue('below');
    await position.selectOption('beside');
    await expect(handle).toBeVisible();
    const before = await width(), plan = await drawing.boundingBox();
    assert.ok(Math.abs(plan.x + plan.width - (await handle.boundingBox()).x) < 2);
    const grip = await handle.boundingBox();
    const header = await page.locator('.app-header').boundingBox();
    const pointerY = Math.max(header.y + header.height, grip.y) + 40;
    await page.mouse.move(grip.x + grip.width / 2, pointerY);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 60, pointerY, {steps:5});
    await page.mouse.up();
    await expect.poll(width).toBe(before + 60);
    assert.ok(Math.abs((await drawing.boundingBox()).width - (plan.width - 60)) < 2);
    await handle.press('ArrowRight');
    await expect.poll(width).toBe(before + 50);
    await handle.press('Home');
    await expect.poll(width).toBe(Number(await handle.getAttribute('aria-valuemin')));
    await handle.press('End');
    await expect.poll(width).toBe(Number(await handle.getAttribute('aria-valuemax')));
    const wide = await width();
    await page.setViewportSize({width:600,height:900});
    await expect(handle).toBeHidden();
    const stacked = await drawing.boundingBox(), register = await pane.boundingBox();
    assert.ok(register.y >= stacked.y + stacked.height && Math.abs(register.width - stacked.width) < 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({width:1384,height:900});
    await expect.poll(width).toBe(wide);
    await handle.press('Home');
    await position.selectOption('below');
    await expect(handle).toBeHidden();
  }
}

module.exports = { checkRegisterSplit };
