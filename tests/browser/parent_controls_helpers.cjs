"use strict";
const { expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

// These are the accepted original user assets, independent of the served files.
const originals = {
  '/icons/takeoff-add-service.png': { bytes: 101430, sha256: '65fed5b7670ec4b0a32712449e7dd456a7f05694e493b3c5dbf57eaac394a091' },
  '/icons/takeoff-add-barrier.png': { bytes: 99940, sha256: 'bcf83c1ae1debaf4d4cf28fdba74c782760d32a7f1a5d61a013b8ee3ebb39d58' },
};

async function assertParentControls(page, pane, { hasBarrier = false, keyboard = true } = {}) {
  const actions = pane.locator('.takeoff-physical-item-actions');
  const labels = ['Add Library Item', 'Add service in Item Details', ...(hasBarrier ? ['Add barrier in Item Details'] : [])];
  await expect(actions).toBeVisible();
  await actions.scrollIntoViewIfNeeded();
  assert.deepEqual(await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), labels);
  const boxes = [];
  for (const label of labels) {
    const button = actions.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    assert.equal((await button.innerText()).trim(), '');
    const box = await button.boundingBox();
    assert.equal(box.width, 38); assert.equal(box.height, 38); boxes.push(box);
    if (label === 'Add Library Item') {
      await expect(button.locator('svg')).toHaveCount(1);
    } else {
      const img = button.locator('img');
      await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBe(1000);
      const rendered = await img.evaluate(el => ({ src: new URL(el.src).pathname, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, complete: el.complete }));
      const original = originals[rendered.src]; assert.ok(original, rendered.src);
      assert.deepEqual({ ...rendered, src: undefined }, { src: undefined, width: 30, height: 30, naturalWidth: 1000, naturalHeight: 1000, complete: true });
      const reply = await page.request.get(new URL(rendered.src, page.url()).href); assert.equal(reply.status(), 200);
      const body = await reply.body(); assert.equal(body.length, original.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), original.sha256);
    }
    if (keyboard) {
      await page.keyboard.press('Tab'); await button.focus(); await expect(button).toBeFocused();
      assert.equal(await button.evaluate(el => el.matches(':focus-visible')), true);
      const outline = await button.evaluate(el => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
      assert.notEqual(outline.style, 'none'); assert.ok(outline.width >= 2, JSON.stringify(outline));
    }
  }
  for (let i = 1; i < boxes.length; i++) { assert.ok(Math.abs(boxes[i].y - boxes[0].y) < 1); assert.ok(boxes[i].x > boxes[i - 1].x + boxes[i - 1].width); }
  const order = await pane.evaluate(el => {
    const children = [...el.children], index = selector => children.findIndex(child => child.matches(selector));
    const actionRow = el.querySelector('.takeoff-physical-inspector-actions');
    return { add: index('.takeoff-physical-item-actions'), records: index('.takeoff-physical-inspector-actions'), navigation: index('.takeoff-physical-navigation'), labels: [...actionRow.querySelectorAll('button')].map(button => button.getAttribute('aria-label')) };
  });
  assert.ok(order.add >= 0 && order.add < order.records && order.records < order.navigation, JSON.stringify(order));
  assert.deepEqual(order.labels, ['Delete draft record', 'Discard unfinished physical edits', ...(order.labels.includes('Visibility') ? ['Visibility'] : [])]);
  const recordBoxes=await pane.locator('.takeoff-physical-inspector-actions button').evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};}));
  for(let i=0;i<recordBoxes.length;i++){assert.equal(recordBoxes[i].width,38);assert.equal(recordBoxes[i].height,38);if(i){assert.ok(Math.abs(recordBoxes[i].y-recordBoxes[0].y)<1);assert.ok(recordBoxes[i].x>recordBoxes[i-1].x+recordBoxes[i-1].width);}}
  return { iconControls: true, exactOriginalAssetBytes: true, keyboardFocus: keyboard, labels, order };
}

module.exports = { assertParentControls, originals };
