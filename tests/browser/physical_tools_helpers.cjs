"use strict";
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

// Read rendered controls in a disposable fixture. Physical Undo shares the
// Steel register's control family and the same existing Schedule symbol.
function contrast(foreground, background) {
  const luminance = value => {
    const rgb = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    assert.ok(rgb, `Control contrast requires an opaque rendered colour: ${value}`);
    const channels = rgb.slice(1).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
async function assertReadableControl(control) {
  const paint = await control.evaluate(el => {
    const css = getComputedStyle(el), svg = el.querySelector('svg');
    return { color: css.color, background: css.backgroundColor, backgroundImage: css.backgroundImage, glyph: svg ? getComputedStyle(svg).stroke : css.color };
  });
  const stops = paint.backgroundImage === 'none' ? [paint.background] : paint.backgroundImage.match(/rgba?\([^)]*\)/g) || [];
  assert.ok(stops.length, 'Control exposes its opaque painted surface');
  paint.contrast = stops.map(background => ({ background, text: contrast(paint.color, background), glyph: contrast(paint.glyph === 'none' ? paint.color : paint.glyph, background) }));
  for (const value of paint.contrast) { assert.ok(value.text >= 4.5, 'Control text remains readable against every painted gradient stop'); assert.ok(value.glyph >= 4.5, 'Control glyph remains readable against every painted gradient stop'); }
  return paint;
}
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
    const undo = button('Undo last edit'), reference = document.querySelector('#penetration-undo'), selection = button('Select filtered records');
    const steelUndo = document.querySelector('.takeoff-register:not(.takeoff-physical-register) .takeoff-undo-button');
    const box = control => { const r = control.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const style = control => Object.fromEntries(['display','alignItems','justifyItems','width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopColor','borderTopLeftRadius','color','backgroundColor','fontSize','fontWeight','boxShadow'].map(key => [key, getComputedStyle(control)[key]]));
    const glyph = control => Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','color'].map(key => [key, getComputedStyle(control.querySelector('.button-symbol'))[key]]));
    const transfer = button('Transfer to Firestopping Schedule'), update = button('Update linked rows'), unlink = button('Unlink from Firestopping Schedule');
    const documentMenu = document.querySelector('.takeoff-workspace-heading .takeoff-physical-document-host .takeoff-document-menu'), documentHost = documentMenu.parentElement, tools = document.querySelector('.takeoff-workspace-heading .takeoff-pdf-tools-menu');
    return {
      theme: document.documentElement.dataset.theme || 'ceasefire',
      firstRow: box(first), actionsRow: box(actions), register: box(el), registerBackground:getComputedStyle(el).backgroundColor,
      controls: [transfer, update, unlink].map(box),
      document: { box: box(documentMenu), tools: box(tools), directlyBeforeTools: documentHost.nextElementSibling === tools, absentFromRegister: !el.querySelector('.takeoff-document-menu') },
      actionsOrder: [...actions.children].map(control => control.getAttribute('aria-label') || control.className),
      firstRowOwnsFilterSelectionUndo: first.classList.contains('takeoff-physical-filter-row') && undo.parentElement === first && button('Select filtered records').parentElement === first && [...first.querySelectorAll('label')].some(label => label.textContent === 'Show deleted records' && label === undo.nextElementSibling),
      adjacentRows: first.nextElementSibling === actions,
      undo: { box: box(undo), style: style(undo), glyph: glyph(undo) },
      selection: { box: box(selection), directlyBeforeUndo: undo.previousElementSibling === selection },
      scheduleUndo: { style: style(reference), glyph: glyph(reference), text: reference.querySelector('.button-symbol').textContent, backgroundImage: getComputedStyle(reference).backgroundImage },
      steelUndo: { style: style(steelUndo), glyph: glyph(steelUndo), text: steelUndo.querySelector('.button-symbol').textContent },
    };
  });
  assert.equal(measured.firstRowOwnsFilterSelectionUndo, true);
  assert.equal(measured.adjacentRows, true);
  assert.deepEqual(measured.actionsOrder, ['Transfer to Firestopping Schedule', 'Update linked rows', 'Unlink from Firestopping Schedule']);
  assert.equal(measured.document.directlyBeforeTools, true);assert.equal(measured.document.absentFromRegister, true);
  assert.ok(measured.document.box.right <= measured.document.tools.x + 1 && Math.abs(measured.document.box.y - measured.document.tools.y) < 1, 'Physical Document immediately precedes Tools on the heading row');
  assert.ok(measured.actionsRow.y >= measured.firstRow.bottom, 'Schedule actions occupy the following row');
  assert.ok(Math.abs(measured.controls[0].x - measured.actionsRow.x) < 1, 'Transfer starts at the left of its row');
  for (let index = 1; index < measured.controls.length; index++) {
    assert.ok(Math.abs(measured.controls[index].x - measured.controls[index - 1].right - 8) < 1, 'Each Schedule action follows its neighbour');
  }
  assert.ok(measured.controls.at(-1).right <= measured.register.right + 1, 'The action row fits the register');
  assert.equal(measured.selection.directlyBeforeUndo,true);assert.equal(measured.undo.box.width,measured.selection.box.width);assert.equal(measured.undo.box.height,measured.selection.box.height);assert.equal(measured.undo.box.width,38);assert.equal(measured.undo.box.height,38);
  assert.equal(measured.scheduleUndo.text, '↶');
  assert.equal(measured.steelUndo.text,measured.scheduleUndo.text,'Both registers retain the original Undo symbol');
  assert.deepEqual(measured.undo.style,measured.steelUndo.style,'Physical Undo shares the actual Steel register geometry, typography and paint');
  assert.deepEqual(measured.undo.glyph,measured.steelUndo.glyph,'Physical Undo shares the Steel register symbol font and colour');
  assert.equal(measured.undo.glyph.color,measured.undo.style.color,'Undo glyph follows its readable button colour');
  measured.undo.contrast=await assertReadableControl(undo);
  const background=measured.scheduleUndo.backgroundImage;
  const stops=background==='none'?[measured.scheduleUndo.style.backgroundColor]:background.match(/rgba?\([^)]*\)/g)||[];
  assert.ok(stops.length,'Schedule Undo exposes opaque painted colours for contrast');
  measured.scheduleUndo.contrast=stops.map(stop=>({background:stop,ratio:contrast(measured.scheduleUndo.glyph.color,stop)}));
  for(const value of measured.scheduleUndo.contrast)assert.ok(value.ratio>=4.5,'Schedule Undo glyph remains readable against every opaque gradient stop');
  return measured;
}
module.exports = { assertPhysicalTools, assertReadableControl, contrast };
