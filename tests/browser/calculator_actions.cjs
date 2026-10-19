// Choose through the same header disclosure used by mouse, keyboard and touch.
// No calculator state is changed through a test-only application bridge.
const { expect } = require('@playwright/test');
async function chooseCalculator(page, name) {
  const firestopping = ['Firestopping', 'Firestopping Estimator'].includes(name);
  const toggle = page.getByRole('button', { name: 'Calculators', exact: true });
  await toggle.hover();
  const menu = page.getByRole('group', { name: 'Choose a calculator', exact: true });
  await expect(menu).toBeVisible();
  if (['Steel (spray)', 'Steel (board)'].includes(name)) {
    await page.locator('#steel-calculator-navigation-toggle').click();
    await page.locator('#steel-calculator-navigation-menu').getByRole('button', { name, exact: true }).click();
  } else await menu.getByRole('button', { name: firestopping ? 'Firestopping' : name === 'Ductwork (spray/wrap)' ? 'Duct' : name, exact: true }).click();
}
module.exports = { chooseCalculator };
