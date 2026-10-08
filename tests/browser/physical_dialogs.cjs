const { expect } = require('@playwright/test');
const { takeoffChoice } = require('./section_navigation.cjs');

// Exercise the real chooser before the existing manual Defect form.
async function chooseNewDefect(page) {
  return chooseNewPhysicalItem(page, 'defect');
}

async function chooseNewPhysicalItem(page, kind) {
  if (kind !== 'defect' && (kind !== 'barrier' || await takeoffChoice(page, 'Service Plans').getAttribute('aria-pressed') !== 'true')) return;
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: kind === 'defect' ? 'Add Defect' : 'Add Barrier', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Choose item', { exact: true })).toBeVisible();
  await dialog.getByLabel('Choose item', { exact: true }).selectOption('new');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  if (kind === 'defect') await expect(dialog.getByLabel('Defect Ref.', { exact: true })).toBeVisible();
  else await expect(dialog.getByRole('heading', { name: 'Create draft barrier', exact: true })).toBeVisible();
}

async function startDefect(page) {
  return startPhysicalItem(page);
}

async function startPhysicalItem(page, position = [.72, .35]) {
  await expect(page.getByRole('button', { name: 'Add defect', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Call-out', exact: true }).click();
  const viewport = page.locator('.takeoff-viewport');
  await viewport.scrollIntoViewIfNeeded();
  const point = await viewport.evaluate((el, position) => {
    const frame = el.getBoundingClientRect(), paper = el.querySelector('.takeoff-overlay').getBoundingClientRect();
    const header = document.querySelector('header').getBoundingClientRect();
    const left = Math.max(frame.left, paper.left, 0), right = Math.min(frame.right, paper.right, innerWidth);
    const top = Math.max(frame.top, paper.top, header.bottom + 12), bottom = Math.min(frame.bottom, paper.bottom, innerHeight - 90);
    return [left + (right - left) * position[0], top + (bottom - top) * position[1]];
  }, position);
  expect(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest('.takeoff-overlay'), point)).toBe(true);
  await page.mouse.click(...point);
  await expect(page.getByRole('dialog').getByLabel('Choose item', { exact: true })).toBeVisible();
}

module.exports = { chooseNewDefect, chooseNewPhysicalItem, startDefect, startPhysicalItem };
