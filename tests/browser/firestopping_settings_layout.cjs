const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function checkSettingsLayout(page, output, theme) {
  const settings = page.locator('#penetration-row-fields .penetration-settings');
  const tables = settings.locator('.penetration-settings-table');
  const bands = settings.locator('.penetration-band-settings');
  const widths = theme === 'ceasefire' ? [1600, 390] : [1600];
  const viewport = page.viewportSize();
  assert.ok(await tables.count() >= 4);
  await expect(bands.locator('summary > strong')).toContainText(['Pipe Labour', 'Board Task Hours']);
  for (const band of await bands.all()) {
    if (!await band.evaluate(el => el.open)) await band.locator('summary').click();
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: viewport.height });
    await page.mouse.move(0, 0);
    const sections = await tables.evaluateAll(elements => elements.map(table => {
      const columns = table.tHead.rows[0].cells;
      const [first, last] = [columns[0], columns[columns.length - 1]].map(el => getComputedStyle(el));
      return [first.borderStartStartRadius, last.borderStartEndRadius, first.borderStartEndRadius,
        last.borderStartStartRadius, getComputedStyle(table.parentElement).overflowX];
    }));
    for (const section of sections) assert.deepEqual(section, ['8px', '8px', '0px', '0px', 'auto']);
    const headings = settings.locator('th[scope="rowgroup"]');
    assert.ok((await headings.allTextContents()).includes('Material waste'));
    assert.ok((await headings.allTextContents()).includes('Labour allowances'));
    for (const heading of await headings.all()) {
      await expect(heading).toHaveCSS('border-top-left-radius', '8px');
      await expect(heading).toHaveCSS('border-top-right-radius', '8px');
      await expect(heading).toHaveCSS('background-color', 'rgb(17, 17, 17)');
    }
    const remove = bands.first().getByRole('button', { name: 'Remove Pipe Labour band 1', exact: true });
    await expect(remove).toBeVisible();
    await expect(remove).toHaveCSS('width', '44px');
    await expect(remove).toHaveCSS('height', '44px');
    const paint = el => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.backgroundImage, s.borderTopColor, s.color, s.borderRadius,
        el.querySelector('svg').outerHTML];
    };
    assert.deepEqual(await remove.evaluate(paint), await page.locator('#company-cover-delete').evaluate(paint));
    if (theme === 'ceasefire') {
      for (const [i, table] of (await tables.all()).entries()) {
        await table.locator('thead').screenshot({ path: path.join(output, `settings-header-${width}-${i}.png`) });
      }
      for (const [i, heading] of (await headings.all()).entries()) {
        await heading.screenshot({ path: path.join(output, `settings-group-${width}-${i}.png`) });
      }
      await remove.screenshot({ path: path.join(output, `settings-trash-${width}.png`) });
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  // A table wider than its viewport must still scroll to its final column.
  const scrolled = await tables.last().evaluate(table => {
    const wrapper = table.parentElement;
    const previous = table.style.minWidth;
    table.style.minWidth = (wrapper.clientWidth + 100) + 'px';
    wrapper.scrollLeft = 70;
    const distance = wrapper.scrollLeft;
    table.style.minWidth = previous;
    wrapper.scrollLeft = 0;
    return distance;
  });
  assert.ok(scrolled > 0);
  await page.setViewportSize(viewport);
}

module.exports = { checkSettingsLayout };
