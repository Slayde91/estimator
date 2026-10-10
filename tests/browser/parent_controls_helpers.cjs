"use strict";
const { expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

// These are the accepted original user assets, independent of the served files.
const originals = {
  '/icons/takeoff-add-service.png': { bytes: 101430, sha256: '65fed5b7670ec4b0a32712449e7dd456a7f05694e493b3c5dbf57eaac394a091' },
  '/icons/takeoff-add-barrier.png': { bytes: 99940, sha256: 'bcf83c1ae1debaf4d4cf28fdba74c782760d32a7f1a5d61a013b8ee3ebb39d58' },
  '/icons/takeoff-transfer.png': { bytes: 21575, sha256: '1b5552f06a1cb61d246e969f70a5243883a8ba6b1ddaa5392ddd737d802f1d1b' },
};

async function assertTransferIcon(page) {
  const button = page.locator('.takeoff-physical-register').getByRole('button', { name: 'Transfer to Firestopping Schedule', exact: true }), img = button.locator('img'), source = '/icons/takeoff-transfer.png', original = originals[source];
  await expect(img).toHaveAttribute('src', source);
  const reply = await page.request.get(new URL(source, page.url()).href); assert.equal(reply.status(), 200, 'The accepted Transfer PNG must be served');
  const body = await reply.body(); assert.equal(body.length, original.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), original.sha256);
  await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBe(512);
  assert.deepEqual(await img.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, naturalHeight: el.naturalHeight, decorative: el.getAttribute('aria-hidden') })), { width: 24, height: 24, naturalHeight: 512, decorative: 'true' });
  return { exactOriginalTransferBytes: true, loadedTransferIcon: true };
}

async function clickInspectorAdd(pane, label) {
  const toggle = pane.getByRole('button', { name: 'Add', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await pane.locator('.takeoff-physical-add-menu').getByRole('button', { name: label, exact: true }).click();
}

async function assertParentControls(page, pane, { hasBarrier = false, keyboard = true } = {}) {
  const actions = pane.locator('.takeoff-physical-item-actions');
  const menu = actions.locator('.takeoff-physical-add-menu'), toggle = menu.getByRole('button', { name: 'Add', exact: true }), list = menu.getByRole('group', { name: 'Add item actions', includeHidden: true });
  const labels = [...(hasBarrier ? ['Add barrier in Item Details'] : []), 'Add service in Item Details', 'Add Library Item'];
  const names = [...(hasBarrier ? ['Add Barrier'] : []), 'Add Service', 'Add Library Item'];
  await expect(actions).toBeVisible();
  await actions.scrollIntoViewIfNeeded();
  await expect(toggle).toHaveText('Add'); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(list).toBeHidden();
  assert.equal(await toggle.getAttribute('aria-controls'), await list.getAttribute('id'));
  // Mouse-open must expose every choice before keyboard focus can scroll a
  // clipped final entry into view and accidentally conceal the regression.
  await toggle.click();
  const mouseOpen = await list.evaluate(el => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const clip = el.closest('.takeoff-physical-details') || el.closest('aside');
    return { popup: rect(el), clip: rect(clip), viewport: { width: innerWidth, height: innerHeight }, entries: [...el.querySelectorAll('button')].map(button => { const box = rect(button); return { name: button.textContent.trim(), box, centerReceivesPointer: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) }; }) };
  });
  assert.deepEqual(mouseOpen.entries.map(entry => entry.name), names);
  assert.ok(mouseOpen.entries.every(entry => entry.centerReceivesPointer), `Mouse-open exposes all Add entries together: ${JSON.stringify(mouseOpen)}`);
  assert.ok(mouseOpen.popup.x >= mouseOpen.clip.x && mouseOpen.popup.right <= mouseOpen.clip.right, 'Add popup fits the scrolling inspector width');
  assert.ok(mouseOpen.popup.y >= mouseOpen.clip.y && mouseOpen.popup.bottom <= mouseOpen.clip.bottom, 'Add popup fits the actual scrolling inspector');
  assert.ok(mouseOpen.popup.x >= 0 && mouseOpen.popup.right <= mouseOpen.viewport.width, 'Add popup fits the viewport width');
  assert.ok(mouseOpen.popup.y >= 0 && mouseOpen.popup.bottom <= mouseOpen.viewport.height, 'Add popup fits the viewport');
  await toggle.click(); await expect(list).toBeHidden();
  await toggle.focus(); await toggle.press('ArrowDown'); await expect(list.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(list.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(list.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(list.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(list.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(list).toBeHidden();
  await toggle.click();
  assert.deepEqual(await list.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), labels);
  assert.deepEqual(await list.locator('button > span').allTextContents(), names);
  const boxes = [];
  for (const label of labels) {
    const button = list.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    assert.ok(box.width >= 100); assert.ok(box.height >= 44); boxes.push(box);
    const geometry = await button.evaluate(el => { const icon = el.firstElementChild.getBoundingClientRect(), name = el.lastElementChild.getBoundingClientRect(); return { iconRight: icon.right, textLeft: name.left, iconCentre: icon.y + icon.height / 2, textCentre: name.y + name.height / 2 }; });
    assert.ok(geometry.iconRight < geometry.textLeft); assert.ok(Math.abs(geometry.iconCentre - geometry.textCentre) < 1);
    assert.equal(await button.evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), true, `${label}: Add choice is not covered by viewer controls`);
    if (label === 'Add Library Item') {
      await expect(button.locator('svg')).toHaveCount(1);
      assert.deepEqual(await button.locator('linearGradient stop').evaluateAll(stops => stops.map(stop => stop.getAttribute('stop-color'))), ['#ff0000', '#ff6600', '#ffa600']);
      const gradient = await button.locator('linearGradient').getAttribute('id');
      assert.deepEqual(await button.locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('stroke'))), [`url(#${gradient})`, `url(#${gradient})`]);
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
  for (let i = 1; i < boxes.length; i++) { assert.ok(Math.abs(boxes[i].x - boxes[0].x) < 1); assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].height); }
  const popup = await list.boundingBox(), paneBox = await pane.boundingBox(), toggleBox = await toggle.boundingBox(), chevronBox = await toggle.locator('.calculator-document-chevron').boundingBox();
  assert.ok(popup.x >= paneBox.x - 1 && popup.x + popup.width <= paneBox.x + paneBox.width + 1, 'Add choices fit the inspector');
  assert.ok(chevronBox.x > toggleBox.x + toggleBox.width / 2, 'Add arrow sits at the right');
  await pane.locator('h3').filter({ hasText: /^Item Details$/ }).click(); await expect(list).toBeHidden(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click(); await pane.getByRole('button', { name: 'Discard unfinished physical edits', exact: true }).focus(); await expect(list).toBeHidden();
  const order = await pane.evaluate(el => {
    const children = [...el.children], index = selector => children.findIndex(child => child.matches(selector));
    const actionRow = el.querySelector('.takeoff-physical-inspector-actions');
    const itemRow = el.querySelector('.takeoff-physical-item-actions'), visibility = itemRow.querySelector('[aria-label="Visibility"]');
    return { add: index('.takeoff-physical-item-actions'), records: index('.takeoff-physical-inspector-actions'), navigation: index('.takeoff-physical-navigation'), notes: children.findIndex(child => child.querySelector('[aria-label="Notes"]')), labels: [...actionRow.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), visibilityAtEnd: !visibility || visibility === itemRow.lastElementChild };
  });
  assert.ok(order.add >= 0 && order.add < order.navigation && order.navigation < order.notes && order.records === order.notes + 1, JSON.stringify(order));
  assert.deepEqual(order.labels, ['Delete draft record', 'Discard unfinished physical edits']); assert.equal(order.visibilityAtEnd, true);
  const recordBoxes=await pane.locator('.takeoff-physical-inspector-actions button').evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};}));
  for(let i=0;i<recordBoxes.length;i++){assert.equal(recordBoxes[i].width,38);assert.equal(recordBoxes[i].height,38);if(i){assert.ok(Math.abs(recordBoxes[i].y-recordBoxes[0].y)<1);assert.ok(recordBoxes[i].x>recordBoxes[i-1].x+recordBoxes[i-1].width);}}
  const visibility = actions.getByRole('button', { name: 'Visibility', exact: true });
  let visibilityAlignment;
  if (await visibility.count()) { const box = await visibility.boundingBox(), row = await actions.boundingBox(), currentToggleBox = await toggle.boundingBox(); assert.equal(box.width,38); assert.equal(box.height,38); assert.ok(Math.abs(box.y-currentToggleBox.y)<1); assert.ok(Math.abs(box.x+box.width-row.x-row.width)<1, 'Visibility is at the far right of Add'); visibilityAlignment = { beforeDismissalToggleY: toggleBox.y, currentToggleY: currentToggleBox.y, visibilityY: box.y }; }
  const fields = await pane.locator(':scope > label.field > span').allTextContents();
  if (fields.includes('Confirmation')) assert.equal(fields.indexOf('Confirmation')+1,fields.indexOf('Notes'),'Owning Confirmation precedes Notes');
  const appearance = pane.locator('.takeoff-settings-fields');
  if (await appearance.count()) assert.deepEqual((await appearance.locator('.field > span').allTextContents()).slice(0,4),['Fill colour','Fill enabled','Line Colour','Line Width']);
  return { addDisclosure: true, exactOriginalAssetBytes: true, gradientLibraryBook: true, keyboardFocus: keyboard, labels, names, order, mouseOpen, visibilityAlignment };
}

module.exports = { assertParentControls, assertTransferIcon, clickInspectorAdd, originals };
