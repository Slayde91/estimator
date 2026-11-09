const {expect} = require('@playwright/test');

async function drawSwmsSignature(page, owner) {
  await owner.getByRole('button', {name: 'Draw signature', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Signatures', exact: true});
  const pad = await dialog.getByLabel('Signature drawing pad').boundingBox();
  await page.mouse.move(pad.x + 25, pad.y + 60); await page.mouse.down();
  await page.mouse.move(pad.x + 110, pad.y + 20, {steps: 5});
  await page.mouse.move(pad.x + 150, pad.y + 65, {steps: 5}); await page.mouse.up();
  await dialog.getByRole('button', {name: 'Insert signature', exact: true}).click();
  await expect(owner.getByRole('img')).toBeVisible();
}

// Opt-in only at successful PDF boundaries. Blank-draft and signing/default
// assertions run first; fill no existing detail and use the actual public pad.
async function prepareSwmsForIssue(page) {
  const host = page.locator('#swms-root');
  const details = host.locator(':scope > details').filter({has: page.locator(':scope > summary').filter({hasText: /^Project Details$/})});
  if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
  for (const [label, value] of [['Contact Person', 'Synthetic Contact'], ['Position', 'Supervisor'], ['Phone', '0400 000 001'], ['Principal Contractor (PC)', 'Synthetic Builder'], ['Project Address', '1 Synthetic SWMS Street']]) {
    const input = details.getByLabel(label, {exact: true});
    if (!(await input.inputValue()).trim()) await input.fill(value);
  }
  for (const heading of ['Person/s responsible for reviewing SWMS', 'This SWMS has been developed in consultation with']) {
    const section = host.locator(':scope > details').filter({has: page.locator(':scope > summary').filter({hasText: heading})});
    if (!await section.evaluate(node => node.open)) await section.locator(':scope > summary').click();
    if (!await section.locator('.swms-person').count()) await section.getByRole('button', {name: 'Add person', exact: true}).click();
    for (const person of await section.locator('.swms-person').all()) {
      for (const [label, value] of [['Name', 'Synthetic Reviewer'], ['Position', 'Supervisor']]) {
        const input = person.getByLabel(label, {exact: true});
        if (!(await input.inputValue()).trim()) await input.fill(value);
      }
      if (await person.getByRole('button', {name: 'Draw signature', exact: true}).count()) await drawSwmsSignature(page, person);
    }
  }
  const choices = host.locator('.swms-check-grid input:checked');
  const risk = host.locator('[data-swms-required-path="high_risk_work"]');
  if (!await risk.locator('input:checked').count()) {
    if (!await risk.evaluate(node => node.open)) await risk.locator(':scope > summary').click();
    await risk.getByLabel('NA', {exact: true}).check();
  }
  const works = host.locator('[data-swms-required-path="work_types"]');
  if (!await works.locator('.swms-check-grid input:checked').count()) {
    if (!await works.evaluate(node => node.open)) await works.locator(':scope > summary').click();
    await works.getByLabel('Passive Firestopping', {exact: true}).check();
  }
}

module.exports = {drawSwmsSignature, prepareSwmsForIssue};
