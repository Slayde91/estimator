const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');
const { chooseLibrary } = require('./section_navigation.cjs');

async function checkLibraryControlSizes(page, output) {
  const measurements = [];
  const documentButton = page.locator('[aria-controls="pricing-document-actions"]');
  const prices = page.locator('#library-pricing > .card');
  async function measure(controls, label, minimumCount) {
    const sizes = await controls.evaluateAll(nodes => nodes.map(node => {
      const {width, height} = node.getBoundingClientRect();
      return {control: node.getAttribute('aria-label') || node.id || node.textContent.trim(), width, height};
    }));
    assert.ok(sizes.length >= minimumCount, label + ' includes its controls');
    for (const size of sizes) assert.equal(size.height, 42, label + ' ' + size.control);
    measurements.push({width: page.viewportSize().width, label, sizes});
  }
  for (const width of [1384, 390]) {
    await page.setViewportSize({width, height:900});
    await chooseLibrary(page, 'pricing');
    const firstRow = prices.locator('tr[data-price-kind="inventory"]').first();
    await expect(firstRow).toBeVisible();
    await documentButton.click();
    await measure(prices.locator('.pricing-table-actions button:visible, .pricing-controls input, .pricing-controls select'), 'Pricing controls', 10);
    await page.keyboard.press('Escape');
    await measure(firstRow.locator('input, textarea, button'), 'Pricing row', 9);
    const rowBounds = await firstRow.locator('.pricing-row-actions').evaluate(cell => {
      const box = cell.getBoundingClientRect(), buttons = [...cell.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return buttons.every(r => r.x >= box.x && r.right <= box.right && r.width === 42) && buttons[0].right <= buttons[1].left;
    });
    assert.ok(rowBounds, 'Both row actions fit their column at ' + width);
    const product = firstRow.locator('textarea');
    const resizable = await product.evaluate(control => {
      if (getComputedStyle(control).resize !== 'vertical') return false;
      control.style.height = '86px';
      const expanded = control.getBoundingClientRect().height;
      control.style.removeProperty('height');
      return expanded === 86 && control.getBoundingClientRect().height === 42;
    });
    assert.ok(resizable, 'Product/Service can grow above its initial height');
    await prices.locator('.pricing-table-actions').screenshot({path:path.join(output, 'pricing-actions-' + width + '.png')});
    for (const [kind, id] of [['penetration','pkb-001'], ['technical','report-a-v1']]) {
      await chooseLibrary(page, kind);
      const pane = page.locator('#library-' + kind), item = pane.locator('[data-library-record="' + id + '"]');
      await expect(item).toBeVisible();
      if (kind === 'technical') await measure(pane.locator('[data-library-create]'), 'Technical Add', 1);
      const card = pane.locator('.library-result').filter({has:page.locator('[data-library-record="' + id + '"]')});
      await measure(card.locator('.library-item-actions > button'), kind + ' record card', 4);
      await item.click();
      const actions = pane.locator('.library-detail .library-item-actions').first();
      await expect(actions).toBeVisible();
      await measure(actions.locator('button'), kind + ' record detail', 4);
      await actions.screenshot({path:path.join(output, kind + '-actions-' + width + '.png')});
      await pane.locator('[data-library-back-to-results]').click();
    }
  }
  return measurements;
}
module.exports = { checkLibraryControlSizes };
