"use strict";
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

// Read rendered controls in a disposable fixture; retain the real Schedule as
// the visual reference rather than inventing a separate expected Undo style.
async function assertPhysicalTools(page) {
  assert.notEqual(new URL(page.url()).port, '8765');
  await page.mouse.move(0, 0);
  const register = page.locator('.takeoff-physical-register');
  const undo = register.getByRole('button', { name: 'Undo last edit', exact: true });
  await expect(undo.locator('.button-symbol')).toHaveText('↶');
  await expect(undo.locator('.button-symbol')).toHaveAttribute('aria-hidden', 'true');
  await expect(undo.locator('svg')).toHaveCount(0);
  const measured = await register.evaluate(el => {
    const filter = el.querySelector('input[type=search]'), first = filter.parentElement;
    const actions = el.querySelector('.takeoff-physical-actions-row');
    const button = label => el.querySelector(`[aria-label="${label}"]`);
    const undo = button('Undo last edit'), reference = document.querySelector('#penetration-undo');
    const box = control => { const r = control.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const style = control => Object.fromEntries(['display','alignItems','justifyItems','width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopColor','borderTopLeftRadius','color','backgroundColor','fontSize','fontWeight','boxShadow'].map(key => [key, getComputedStyle(control)[key]]));
    const glyph = control => Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','color'].map(key => [key, getComputedStyle(control.querySelector('.button-symbol'))[key]]));
    const transfer = button('Transfer to Firestopping Schedule'), update = button('Update linked rows'), unlink = button('Unlink from Firestopping Schedule'), documentMenu = el.querySelector('.takeoff-document-menu');
    return {
      firstRow: box(first), actionsRow: box(actions), register: box(el),
      controls: [transfer, update, unlink, documentMenu].map(box),
      actionsOrder: [...actions.children].map(control => control.getAttribute('aria-label') || control.className),
      firstRowOwnsFilterSelectionUndo: first.classList.contains('takeoff-physical-filter-row') && undo.parentElement === first && button('Select filtered records').parentElement === first && [...first.querySelectorAll('label')].some(label => label.textContent === 'Show deleted records'),
      adjacentRows: first.nextElementSibling === actions,
      undo: { box: box(undo), style: style(undo), glyph: glyph(undo) },
      scheduleUndo: { style: style(reference), glyph: glyph(reference), text: reference.querySelector('.button-symbol').textContent },
    };
  });
  assert.equal(measured.firstRowOwnsFilterSelectionUndo, true);
  assert.equal(measured.adjacentRows, true);
  assert.deepEqual(measured.actionsOrder, ['Transfer to Firestopping Schedule', 'Update linked rows', 'Unlink from Firestopping Schedule', 'calculator-document-menu takeoff-document-menu']);
  assert.ok(measured.actionsRow.y >= measured.firstRow.bottom, 'Schedule actions occupy the following row');
  assert.ok(Math.abs(measured.controls[0].x - measured.actionsRow.x) < 1, 'Transfer starts at the left of its row');
  for (let index = 1; index < measured.controls.length; index++) {
    assert.ok(Math.abs(measured.controls[index].x - measured.controls[index - 1].right - 8) < 1, 'Each action follows its neighbour, with Document immediately after Unlink');
  }
  assert.ok(measured.controls.at(-1).right <= measured.register.right + 1, 'The action row fits the register');
  assert.equal(measured.undo.box.width, 48); assert.equal(measured.undo.box.height, 48);
  assert.equal(measured.scheduleUndo.text, '↶');
  assert.deepEqual(measured.undo.style, measured.scheduleUndo.style, 'Physical Undo matches the actual Firestopping Schedule button');
  assert.deepEqual(measured.undo.glyph, measured.scheduleUndo.glyph, 'Undo uses the same Schedule symbol font and colour');
  return measured;
}
module.exports = { assertPhysicalTools };
