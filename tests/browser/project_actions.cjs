const { expect } = require('@playwright/test');

// New and Load live on Projects; saves are available in the application header.
async function openProjectTools(page) {
  const previous = await page.locator('#view-quotes').isVisible() ? 'quotes' : await page.locator('#view-certification').isVisible() ? 'certification' : await page.locator('.nav-button[aria-current="page"]').getAttribute('data-view');
  if (previous !== 'quotes') {
    await page.locator('nav .nav-button[data-view="projects"]').click();
    const confirmation = page.getByRole('dialog', { name: 'Unsaved Pricing Library', exact: true });
    const target = await Promise.race([
      page.locator('#project-tools').waitFor({ state: 'visible' }).then(() => 'projects'),
      page.locator('#view-projects').waitFor({ state: 'visible' }).then(() => 'hub'),
      page.locator('#view-certification').waitFor({ state: 'visible' }).then(() => 'certification'),
      confirmation.waitFor({ state: 'visible' }).then(() => 'confirmation'),
    ]);
    if (target === 'confirmation') await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#view-quotes, #view-projects, #view-certification').filter({ visible: true })).toHaveCount(1);
    if (await page.locator('#view-certification').isVisible()) await page.locator('#view-certification [data-projects-hub]').click();
    if (await page.locator('#view-projects').isVisible()) await page.locator('#view-projects [data-project-section="quotes"]').click();
  }
  await expect(page.locator('#project-tools')).toBeVisible();
  return previous;
}

async function clickProjectControl(page, name) {
  if (name === 'Save') {
    await page.locator('#header-project-actions').getByRole('button', { name, exact: true }).click();
    return;
  }
  const previous = await openProjectTools(page);
  await page.locator('.project-workspace-actions').getByRole('button', { name, exact: true }).click();
  // Do not wait for a save response here: failure/held-response tests deliberately
  // test the UI before a response exists. Load keeps its review dialog in place.
  if (name !== 'Load' && previous && previous !== 'quotes') {
    if (previous === 'certification') {
      await page.locator('nav .nav-button[data-view="projects"]').click();
      await page.locator('#view-quotes [data-projects-hub]').click();
      await page.locator('#view-projects [data-project-section="certification"]').click();
    } else await page.locator('.nav-button[data-view="' + previous + '"]').click();
  }
}

module.exports = { clickProjectControl, openProjectTools };
