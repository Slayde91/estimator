// Exercise the visible Settings control, then return through the main navigation.
// Keeps each existing browser test on its original workspace and draft.
async function cycleTheme(page) {
  const view = await page.locator('.view:not([hidden])').getAttribute('id');
  await page.locator('nav [data-view="settings"]').click();
  await page.locator('#theme-toggle').click();
  if (view !== 'view-settings') {
    const destination = page.locator(`nav [data-view="${view.replace('view-', '')}"]`);
    await destination.click();
    // Header destinations with submenus open their disclosure on first click.
    // Dismiss it by keyboard so it cannot cover workspace fields.
    if (await destination.getAttribute('aria-expanded') === 'true') await destination.press('Escape');
    await page.mouse.move(0, 0);
  }
}
module.exports = { cycleTheme };
