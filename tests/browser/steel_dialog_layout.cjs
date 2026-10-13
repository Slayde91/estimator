const assert = require('node:assert/strict');
const path = require('node:path');
const checked = new Set();

async function checkSteelDialog(page, modal, output, title) {
  if (!['Add steel object', 'Counted member length'].includes(title)) return;
  if (!await modal.locator('select,[role="combobox"]').count()) return;
  assert.equal(await modal.locator('.takeoff-entry-grid').count(), 1, 'Steel creation fields use two columns');
  const key = title + '-' + await modal.locator('select[name="sides"]').count();
  if (checked.has(key)) return;
  checked.add(key);
  const original = page.viewportSize();
  const values = () => modal.locator('input,select,textarea').evaluateAll(nodes => nodes.map(el => ({name:el.name,value:el.value,checked:el.checked})));
  const before = await values();
  for (const width of [1028, 390]) {
    await page.setViewportSize({width, height:764});
    const geometry = await modal.evaluate(dialog => {
      const grid = dialog.querySelector('.takeoff-entry-grid'), rect = grid.getBoundingClientRect();
      return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        dialog:{left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right},
        fields:[...grid.querySelectorAll('input,select,textarea')].map(el => ({
          name:el.name,choice:el.tagName==='SELECT'||el.getAttribute('role')==='combobox',
          x:el.getBoundingClientRect().left-rect.left,width:el.getBoundingClientRect().width,
        })),width:rect.width};
    });
    assert.equal(geometry.columns,width>600?2:1);
    assert.ok(geometry.dialog.left>=0&&geometry.dialog.right<=width+1,'Dialog fits the screen');
    for(const field of geometry.fields) {
      assert.ok(field.width>0&&field.x+field.width<=geometry.width+1,JSON.stringify(field));
      if(width>600) assert.equal(field.x>geometry.width/2,field.choice,`${field.name} belongs in the ${field.choice?'right':'left'} column`);
    }
    assert.deepEqual(await values(),before,'Responsive layout preserves entered values');
    await page.screenshot({path:path.join(output,`${key.replaceAll(' ','-')}-${width}.png`)});
  }
  await page.setViewportSize(original);
}
module.exports={checkSteelDialog};
