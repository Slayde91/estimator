const { expect } = require('@playwright/test');

// Exercise the real chooser before the existing manual Defect form.
async function chooseNewDefect(page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Choose item', { exact: true })).toBeVisible();
  await dialog.getByLabel('Choose item', { exact: true }).selectOption('new');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByLabel('Defect Ref.', { exact: true })).toBeVisible();
}

module.exports = { chooseNewDefect };
