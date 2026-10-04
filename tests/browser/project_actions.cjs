const { expect } = require('@playwright/test');

// New and Load live on Projects; saves are available in the application header.
async function openProjectTools(page) {
  const previous = await page.locator('.nav-button[aria-current="page"]').getAttribute('data-view');
  if (previous !== 'quotes') {
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Unsaved Pricing Library', exact: true });
    const target = await Promise.race([
      page.locator('#project-tools').waitFor({ state: 'visible' }).then(() => 'projects'),
      confirmation.waitFor({ state: 'visible' }).then(() => 'confirmation'),
    ]);
    if (target === 'confirmation') await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await expect(page.locator('#project-tools')).toBeVisible();
  return previous;
}

async function clickProjectControl(page, name) {
  if (name === 'Save' || name === 'Save As') {
    await page.locator('#header-project-actions').getByRole('button', { name, exact: true }).click();
    return;
  }
  const previous = await openProjectTools(page);
  await page.locator('.project-workspace-actions').getByRole('button', { name, exact: true }).click();
  // Do not wait for a save response here: failure/held-response tests deliberately
  // test the UI before a response exists. Load keeps its review dialog in place.
  if (name !== 'Load' && previous && previous !== 'quotes') {
    await page.locator(`.nav-button[data-view="${previous}"]`).click();
  }
}

module.exports = { clickProjectControl, openProjectTools };
