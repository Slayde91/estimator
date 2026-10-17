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
    await menu.getByRole('button', { name: 'Steel', exact: true }).click();
    // The Pricing Library guard can stop navigation before the landing page.
    await Promise.race([expect(page.locator('#calculator-steel-hub')).toBeVisible(), expect(page.getByRole('dialog')).toBeVisible()]);
    if (await page.getByRole('dialog').isVisible()) return;
    await expect(page.locator('#calculator-steel-hub')).toBeVisible();
    await page.locator('#calculator-steel-hub').getByRole('button', { name, exact: true }).click();
  } else await menu.getByRole('button', { name: firestopping ? 'Firestopping' : name === 'Ductwork (spray/wrap)' ? 'Duct' : name, exact: true }).click();
}
module.exports = { chooseCalculator };
