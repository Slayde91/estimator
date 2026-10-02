// Shared rendered interactions for the automatically applied item settings pane.
const { expect } = require('@playwright/test');
const assert = require('node:assert/strict');

async function settingsSettled(page) {
  await expect.poll(async () => page.evaluate(() => {
    try { window.CeasefireTakeoffs.projectSnapshot(); return true; } catch { return false; }
  })).toBe(true);
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
}

async function openItemSettings(page, id) {
  if (id) {
    await page.locator(`tr[data-item-id="${id}"]`).getByRole('button', { name: 'Edit item', exact: true }).click();
  } else if (!await page.locator('#takeoff-markup-settings').isVisible()) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  const panel = page.locator('#takeoff-markup-settings');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Item details', exact: true })).toBeVisible();
  return panel;
}

async function editSettings(page, values, id) {
  const panel = await openItemSettings(page, id);
  for (const [label, value] of Object.entries(values)) {
    const field = panel.getByLabel(label, { exact: true });
    await expect(field).toBeEnabled();
    const text = String(value);
    if (await field.evaluate(el => el.tagName) === 'SELECT') {
      await expect.poll(() => field.locator('option').evaluateAll(options => options.map(option => option.value))).toContain(text);
      await field.selectOption(text);
    } else {
      await field.fill(text);
      await field.press('Tab');
    }
    await settingsSettled(page);
  }
  const response = await page.request.get(await page.evaluate(() => `${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`));
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

module.exports = { openItemSettings, editSettings, settingsSettled };
