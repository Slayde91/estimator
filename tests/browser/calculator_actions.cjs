// Choose through the same header disclosure used by mouse, keyboard and touch.
// No calculator state is changed through a test-only application bridge.
const { expect } = require('@playwright/test');
async function chooseCalculator(page, name) {
  const firestopping = ['Firestopping', 'Firestopping Estimator'].includes(name);
  const toggle = page.getByRole('button', { name: 'Calculators', exact: true });
  await toggle.hover();
  const menu = page.getByRole('group', { name: 'Choose a calculator', exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: firestopping ? 'Firestopping' : name, exact: true }).click();
}
module.exports = { chooseCalculator };
