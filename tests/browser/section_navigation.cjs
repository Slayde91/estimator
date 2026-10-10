const { expect } = require('@playwright/test');

const takeoffNames = { steel: 'Steel', duct: 'Duct', physical: 'Penetrations', wall: 'Walls/Floors', slab: 'Walls/Floors', walls: 'Walls/Floors', slabs: 'Walls/Floors', walls_floors: 'Walls/Floors', 'walls/floors': 'Walls/Floors', penetrations: 'Penetrations' };
function takeoffChoice(page, name) {
  return page.locator('#takeoff-navigation-menu').getByRole('button', { name: takeoffNames[String(name).toLowerCase()] || name, exact: true, includeHidden: true });
}
async function chooseTakeoff(page, name, { waitForSelection = true } = {}) {
  await page.locator('#takeoff-navigation-toggle').hover();
  if (['Defect Reports', 'Service Plans'].includes(name)) await page.locator('#penetration-navigation-toggle').hover();
  const choice = takeoffChoice(page, name);
  await expect(choice).toBeVisible();
  await choice.click();
  if (waitForSelection) await expect(choice).toHaveAttribute('aria-pressed', 'true', { timeout: 60000 });
  await expect(page.locator('#takeoff-navigation-menu')).toBeHidden();
  // Legacy test callers retain their explicit new-record type in the shared view.
  const native = String(name).toLowerCase();
  if (waitForSelection && ['wall','walls','slab','slabs'].includes(native)) {
    const value = ['slab','slabs'].includes(native) ? 'slab' : 'wall', control = page.getByLabel('New surface type', { exact: true });
    await expect(control).toBeVisible(); if (await control.inputValue() !== value) await control.selectOption(value);
    await expect(control).toHaveValue(value);
  }
}
async function chooseLibrary(page, kind) {
  await page.locator('#library-navigation-toggle').hover();
  const choice = page.locator(`#library-navigation-menu [data-library-kind="${kind}"]`);
  await expect(choice).toBeVisible();
  await choice.click();
}
module.exports = { chooseTakeoff, takeoffChoice, chooseLibrary };
