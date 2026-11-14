'use strict';

async function expandPanels(host, ...labels) {
  for (const label of labels) {
    const summary = host.locator('summary').filter({hasText:new RegExp('^' + label + '(?: \\(\\d+\\))?$')});
    await summary.waitFor({state:'visible'});
    if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
  }
}
module.exports = {expandPanels};
