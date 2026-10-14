const assert = require('node:assert/strict');

async function assertAppearanceLayout(panel) {
  const group = panel.locator('.takeoff-appearance-fields');
  assert.equal(await group.count(), 1, 'The selected appearance editor has one shared layout');
  const layout = await group.evaluate(el => {
    const box = el.getBoundingClientRect();
    return { width: el.clientWidth, scrollWidth: el.scrollWidth, left: box.left, right: box.right,
      fields: [...el.querySelectorAll(':scope > .field')].map(field => {
        const input = field.querySelector('input,select'), bounds = field.getBoundingClientRect();
        return { name: input.name, type: input.type, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      }) };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1, 'Appearance fields fit the actual pane width');
  const mid = (layout.left + layout.right) / 2;
  const fields = layout.fields.filter(field => field.type !== 'checkbox');
  for (const field of fields) {
    if (field.type === 'color') assert.ok(field.right <= mid + 1, `${field.name} is in the left column`);
    if (field.type === 'number') assert.ok(field.left >= mid - 1, `${field.name} is in the right column`);
  }
  const lastField = Math.max(...fields.map(field => field.bottom));
  for (const field of layout.fields.filter(field => field.type === 'checkbox')) assert.ok(field.top >= lastField + 8, `${field.name} is below the other appearance fields`);
  return layout;
}

module.exports = { assertAppearanceLayout };
