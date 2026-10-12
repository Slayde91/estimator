// Exercise the visible Settings control, then return through the main navigation.
// Keeps each existing browser test on its original workspace and draft.
async function cycleTheme(page) {
  const view = await page.locator('.view:not([hidden])').getAttribute('id');
  await page.locator('nav [data-view="settings"]').click();
  await page.locator('#theme-toggle').click();
  if (view !== 'view-settings') await page.locator(`nav [data-view="${view.replace('view-', '')}"]`).click();
}
module.exports = { cycleTheme };
