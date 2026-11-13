const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function checkGroupCorners(page, heading, filename) {
  await heading.scrollIntoViewIfNeeded();
  const clip = await heading.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { x: Math.floor(rect.left) - 3, y: Math.floor(rect.top),
      width: Math.ceil(rect.width) + 6, height: 12 };
  });
  const image = await page.screenshot({ clip, path: filename });
  const pixels = await page.evaluate(async encoded => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + encoded;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    const right = img.width - 1;
    return { left: sample(3, 2), outsideLeft: sample(1, 2), right: sample(right - 3, 2),
      outsideRight: sample(right - 1, 2), inside: sample(14, 3) };
  }, image.toString('base64'));
  assert.deepEqual(pixels.inside, [17, 17, 17]);
  for (const [edge, backing] of [[pixels.left,pixels.outsideLeft],[pixels.right,pixels.outsideRight]]) {
    assert.ok(edge.every((v,i) => Math.abs(v - backing[i]) <= 5), filename + ' ' + JSON.stringify(pixels));
  }
}

async function checkSettingsLayout(page, output, theme, editor = 'calculator') {
  const settings = page.locator(editor === 'library' ? '#library-editor-fields .penetration-settings' : '#penetration-row-fields .penetration-settings');
  const tables = settings.locator('.penetration-settings-table');
  const bands = settings.locator('.penetration-band-settings');
  const widths = theme === 'ceasefire' ? [1600, 390] : [1600];
  const viewport = page.viewportSize();
  assert.ok(await tables.count() >= 4);
  for (const section of await settings.locator('.penetration-settings-section').all()) {
    if (!await section.evaluate(el => el.open)) await section.locator(':scope > summary').click();
  }
  await expect(bands.locator('summary > strong')).toContainText(['Pipe Labour', 'Board Task Hours']);
  for (const band of await bands.all()) {
    if (!await band.evaluate(el => el.open)) await band.locator('summary').click();
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: viewport.height });
    await page.mouse.move(0, 0);
    const horizontal = await settings.evaluate(root => {
      const bounds = root.getBoundingClientRect();
      return [...root.querySelectorAll('table, .table-scroll, .penetration-band-settings, .penetration-settings-subheading')].map(el => {
        const box = el.getBoundingClientRect();
        return [el.className, box.left-bounds.left, box.right-bounds.right];
      });
    });
    for (const [name, left, right] of horizontal) assert.ok(Math.abs(left)<1 && Math.abs(right)<1, JSON.stringify({ name, left, right, width }));
    const subheadings = settings.locator('.penetration-settings-subheading');
    for (const heading of await subheadings.all()) {
      await expect(heading).toHaveCSS('background-color', 'rgb(185, 10, 21)');
      await expect(heading).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(heading).toHaveCSS('border-radius', '8px');
    }
    const cells = await bands.locator('th,td').evaluateAll(cells => cells.map(cell => {
      const control = cell.querySelector('input,button');
      const { x, width } = cell.getBoundingClientRect();
      const rect = control?.getBoundingClientRect();
      return { centered: getComputedStyle(cell).textAlign === 'center',
        offset: rect ? rect.x + rect.width/2 - x - width/2 : 0,
        numeric: control?.tagName === 'INPUT', value: control?.value, width: rect?.width,
        align: control && getComputedStyle(control).textAlign };
    }));
    for (const cell of cells) {
      assert.ok(cell.centered && Math.abs(cell.offset) <= 1, JSON.stringify(cell));
      if (cell.numeric) {
        assert.equal(cell.align, 'center');
        if (cell.value.length <= 5) assert.ok(cell.width >= 42 && cell.width < 100, JSON.stringify(cell));
      }
    }
    // Inspect native sizing with a long valid value, without dispatching an edit into either draft.
    if (width >= 1000) {
      const measure = await bands.first().locator('input').first().evaluate(input => {
        const original = input.value;
        const compact = input.getBoundingClientRect().width;
        input.value = '12.3456789012345';
        const full = input.getBoundingClientRect().width;
        const value = input.value;
        input.value = original;
        return { compact, full, value };
      });
      assert.equal(measure.value, '12.3456789012345');
      assert.ok(measure.full > measure.compact, JSON.stringify(measure));
    }
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
    for (const [i,heading] of (await headings.all()).entries()) {
      await expect(heading).toHaveCSS('border-top-left-radius', '8px');
      await expect(heading).toHaveCSS('border-top-right-radius', '8px');
      await expect(heading).toHaveCSS('background-color', 'rgb(17, 17, 17)');
      await checkGroupCorners(page, heading, path.join(output, `settings-group-corners-${editor}-${theme}-${width}-${i}.png`));
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
      if (editor === 'calculator' && width === 1600) {
        const routeSection = settings.locator('.penetration-settings-section').filter({ has: settings.page().locator('.penetration-route-table') });
        for (const [section,name] of [[routeSection,'service-routes'],[bands.first(),'pipe-labour']]) {
          const clip = await section.evaluate(el => {
            el.scrollIntoView({ block: 'start', behavior: 'instant' });
            const top = document.querySelector('.app-header').getBoundingClientRect().bottom + 15;
            window.scrollBy({ top: el.getBoundingClientRect().top - top, behavior: 'instant' });
            const rect = el.getBoundingClientRect();
            return { x: Math.floor(rect.x), y: Math.floor(rect.y),
              width: Math.ceil(rect.width), height: Math.min(Math.floor(innerHeight - rect.y), Math.ceil(rect.height)) };
          });
          await page.screenshot({ clip, path: path.join(output, name + '.png') });
        }
      }
      for (const [i, table] of (await tables.all()).entries()) {
        await table.locator('thead').screenshot({ path: path.join(output, `settings-header-${editor}-${width}-${i}.png`) });
      }
      await remove.screenshot({ path: path.join(output, `settings-trash-${editor}-${width}.png`) });
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
