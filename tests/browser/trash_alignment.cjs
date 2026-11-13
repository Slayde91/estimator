const assert = require('node:assert/strict');
const {expect} = require('@playwright/test');

async function checkTrashAlignment(button) {
  await expect(button).toBeVisible();
  const metrics = await button.evaluate(control => {
    const buttonBox = control.getBoundingClientRect();
    const glyph = control.querySelector('svg path, .trash-artwork');
    if (!glyph) throw Error('Missing trash artwork for ' + control.getAttribute('aria-label'));
    const glyphBox = glyph.getBoundingClientRect();
    return {
      label:control.getAttribute('aria-label'), width:glyphBox.width, height:glyphBox.height,
      dx:glyphBox.x + glyphBox.width / 2 - buttonBox.x - buttonBox.width / 2,
      dy:glyphBox.y + glyphBox.height / 2 - buttonBox.y - buttonBox.height / 2
    };
  });
  assert.ok(metrics.width > 0 && metrics.height > 0 && Math.abs(metrics.dx) <= 0.5 && Math.abs(metrics.dy) <= 0.5,
    JSON.stringify(metrics));
  return metrics;
}

module.exports = {checkTrashAlignment};
