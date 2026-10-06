const { expect } = require('@playwright/test');

// Exercise the real chooser before the existing manual Defect form.
async function chooseNewDefect(page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Choose item', { exact: true })).toBeVisible();
  await dialog.getByLabel('Choose item', { exact: true }).selectOption('new');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByLabel('Defect Ref.', { exact: true })).toBeVisible();
}

async function startDefect(page) {
  await expect(page.getByRole('button', { name: 'Add defect', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Call-out', exact: true }).click();
  const viewport = page.locator('.takeoff-viewport');
  await viewport.scrollIntoViewIfNeeded();
  const point = await viewport.evaluate(el => {
    const frame = el.getBoundingClientRect(), paper = el.querySelector('.takeoff-overlay').getBoundingClientRect();
    const header = document.querySelector('header').getBoundingClientRect();
    const left = Math.max(frame.left, paper.left, 0), right = Math.min(frame.right, paper.right, innerWidth);
    const top = Math.max(frame.top, paper.top, header.bottom + 12), bottom = Math.min(frame.bottom, paper.bottom, innerHeight - 90);
    return [left + (right - left) * .72, top + (bottom - top) * .35];
  });
  expect(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest('.takeoff-overlay'), point)).toBe(true);
  await page.mouse.click(...point);
  await expect(page.getByRole('dialog').getByLabel('Choose item', { exact: true })).toBeVisible();
}

module.exports = { chooseNewDefect, startDefect };
