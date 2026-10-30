const { expect } = require('@playwright/test');

// New and Load live on Projects; saves are available in the application header.
// Choose an explicit menu destination: the main Projects button now remembers
// whichever subsection was last opened during this app session.
async function openProjectSection(page, section) {
  if (!['quotes', 'certification', 'documentation'].includes(section)) throw new Error('Unknown Projects section: ' + section);
  const destination = page.locator('#view-' + section);
  if (await destination.isVisible()) return;
  await page.locator('#projects-navigation-toggle').hover();
  await expect(page.locator('#projects-navigation-menu')).toBeVisible();
  await page.locator(`#projects-navigation-menu [data-project-section="${section}"]`).click();
  const confirmation = page.getByRole('dialog', { name: 'Unsaved Pricing Library', exact: true });
  const target = await Promise.race([
    destination.waitFor({ state: 'visible' }).then(() => 'section'),
    confirmation.waitFor({ state: 'visible' }).then(() => 'confirmation'),
  ]);
  if (target === 'confirmation') await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(destination).toBeVisible();
}

async function openProjectTools(page) {
  const previous = await page.locator('#view-quotes').isVisible() ? 'quotes' : await page.locator('#view-certification').isVisible() ? 'certification' : await page.locator('#view-documentation').isVisible() ? 'documentation' : await page.locator('.nav-button[aria-current="page"]').getAttribute('data-view');
  if (previous !== 'quotes') await openProjectSection(page, 'quotes');
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
    if (['certification', 'documentation'].includes(previous)) {
      await openProjectSection(page, previous);
    } else if (previous === 'projects') {
      await page.locator('.nav-button[data-view="home"]').click();
      await page.locator('[data-home-view="projects"]').click();
      await expect(page.locator('#view-projects')).toBeVisible();
    } else await page.locator('.nav-button[data-view="' + previous + '"]').click();
  }
}

module.exports = { clickProjectControl, openProjectTools, openProjectSection };
