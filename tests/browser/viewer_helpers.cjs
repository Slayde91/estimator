// A verified page can refine its bitmap without writing duplicate render proof.
// Wait for the actual replacement canvas rather than an optional API request.
const { expect } = require('@playwright/test');

async function renderDrawing(page, action, pageNumber) {
  const canvas = page.locator('.takeoff-viewport canvas');
  const previous = await canvas.count() ? await canvas.elementHandle() : null;
  try {
    await action();
    await page.waitForFunction(old => {
      const canvas = document.querySelector('.takeoff-viewport canvas'), overlay = document.querySelector('.takeoff-overlay');
      return canvas && overlay && canvas !== old && canvas.width > 0 && canvas.height > 0 && (!old || !old.isConnected)
        && Math.abs(parseFloat(canvas.style.width) - Number(overlay.getAttribute('width'))) < .01
        && Math.abs(parseFloat(canvas.style.height) - Number(overlay.getAttribute('height'))) < .01;
    }, previous);
    await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
    await expect(page.locator('.takeoff-progress')).toContainText('Original source');
    await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
    if (pageNumber !== undefined) await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(pageNumber));
  } finally { await previous?.dispose(); }
}

module.exports = { renderDrawing };
