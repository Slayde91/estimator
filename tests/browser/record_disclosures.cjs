'use strict';

async function expandPanels(host, ...labels) {
  for (const label of labels) {
    const summary = host.locator('summary').filter({hasText:new RegExp('^' + label + '(?: \\(\\d+\\))?$')});
    await summary.waitFor({state:'visible'});
    if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
  }
}
async function checkLinkedRecordAppearance(link) {
  const assert = require('node:assert/strict');
  const appearances = await link.evaluate(button => {
    const panel = button.closest('.commercial-side-panel');
    const root = document.documentElement, previous = root.getAttribute('data-theme');
    try {
      return ['ceasefire','midnight','ocean','forest','slate'].map(theme => {
        root.setAttribute('data-theme', theme);
        const css = getComputedStyle(button), panelStyle = getComputedStyle(panel);
        return {theme, ink:panelStyle.color, color:css.color, underline:css.textDecorationColor,
          line:css.textDecorationLine, align:css.textAlign, weight:css.fontWeight, panelWeight:panelStyle.fontWeight};
      });
    } finally {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    }
  });
  for (const style of appearances) {
    assert.equal(style.color, style.ink, style.theme);
    assert.equal(style.underline, 'rgb(200, 16, 46)', style.theme);
    assert.equal(style.line, 'underline', style.theme);
    assert.ok(['start','left'].includes(style.align), style.theme);
    assert.equal(style.weight, style.panelWeight, style.theme);
  }
}
module.exports = {expandPanels, checkLinkedRecordAppearance};
