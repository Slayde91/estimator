// A verified page can refine its bitmap without writing duplicate render proof.
// Wait for the actual replacement canvas rather than an optional API request.
const { expect } = require('@playwright/test');
const { settingsSettled } = require('./settings_helpers.cjs');

async function renderDrawing(page, action, pageNumber) {
  // Reopen can still be loading its worker while the old canvas is present.
  // Finish that render before an action edits a page field it may reset.
  await page.waitForFunction(() => window.CeasefireActivity?.active === false);
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
    // Canvas replacement precedes record_render and auto-calibration replies.
    await page.waitForFunction(() => window.CeasefireActivity?.active === false);
    await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
    if (pageNumber !== undefined) await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(pageNumber));
  } finally { await previous?.dispose(); }
}

// View selects the row before asynchronously navigating and fitting its source.
// A concurrent post-reopen render can still be loading when View focuses.
async function viewRegisterItem(page, id, source) {
  const row = page.locator(`tr[data-item-id="${id}"]`);
  await row.locator('.takeoff-row-link').click();
  await expect(page.locator('.takeoff-viewport')).toBeFocused();
  // Reopening retains the previous canvas while the new PDF worker loads.
  // Focus and matching old canvas dimensions can therefore precede both the
  // current bitmap and its record_render command. Wait for the displayed page
  // before checking settlement, so a late render proof cannot overtake export.
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.takeoff-viewport canvas'), overlay = document.querySelector('.takeoff-overlay');
    return canvas && overlay && canvas.width > 0 && canvas.height > 0
      && Math.abs(parseFloat(canvas.style.width) - Number(overlay.getAttribute('width'))) < .01
      && Math.abs(parseFloat(canvas.style.height) - Number(overlay.getAttribute('height'))) < .01;
  });
  await settingsSettled(page);
  await expect(row.locator('input[type="checkbox"]').first()).toBeChecked();
  const item = await page.evaluate(id => window.CeasefireTakeoffs.projectSnapshot().items.find(item => item.id === id), id);
  expect(item?.geometry).toBeTruthy();
  const geometry = source || item.geometry;
  expect(item.geometry.document_id).toBe(geometry.document_id); expect(item.geometry.page).toBe(geometry.page);
  await expect(page.getByLabel('Drawing document', { exact: true })).toHaveValue(geometry.document_id);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(geometry.page));
}

module.exports = { renderDrawing, viewRegisterItem };
