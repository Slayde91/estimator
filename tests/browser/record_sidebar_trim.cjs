'use strict';
const assert=require('node:assert/strict');

async function checkRecordTrim(page, layout, kind, output) {
  const fs=require('node:fs'),path=require('node:path');
  const view=page.viewportSize(), samples=[];
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:980});
    const result=await layout.evaluate(root=>{
      const left=root.querySelector('.contacts-record-left,.project-workspace-side,.commercial-sidebar:first-child');
      const right=root.querySelector('.contacts-record-right,.project-workspace-links,.commercial-sidebar:last-child');
      const center=root.querySelector('.contacts-record-details,#project-details-pane,.commercial-editor .commercial-details');
      const toolbar=root.querySelector('.commercial-editor-actions,.project-details-actions');
      function paint(el) {
        const css=getComputedStyle(el);
        return {className:el.className, label:(el.querySelector(':scope>summary,:scope>legend,:scope>h2')?.textContent||el.id).trim(),
          color:css.borderTopColor,width:css.borderTopWidth,style:css.borderTopStyle};
      }
      function panels(rail) {
        if(!rail)return [];
        return [...rail.querySelectorAll('details,.card,.contacts-links-group,.crm-identity-section,.crm-timeline')].filter(el=>
          el.getBoundingClientRect().width && !el.parentElement.closest('details,.card,fieldset')).map(paint);
      }
      return {left:panels(left),right:panels(right),center:center&&paint(center),
        toolbar:toolbar && ['Top','Right','Bottom','Left'].map(side=>getComputedStyle(toolbar)['border'+side+'Color'])};
    });
    assert.ok(result.left.length>0 && result.right.length>0 && result.center,kind+' '+JSON.stringify(result));
    for (const edge of [...result.left,...result.right]) {
      assert.equal(edge.color,'rgb(255, 255, 255)',kind+' '+JSON.stringify(edge));
      assert.ok(parseFloat(edge.width)>0 && edge.style==='solid');
    }
    assert.equal(result.center.color,'rgb(237, 0, 27)',kind+' '+JSON.stringify(result.center));
    assert.deepEqual(result.toolbar,Array(4).fill(result.center.color),kind+' toolbar');
    samples.push({width,...result});
  }
  await page.setViewportSize(view);
  fs.writeFileSync(path.join(output,'trim-'+kind+'.json'),JSON.stringify(samples,null,2));
}
module.exports={checkRecordTrim};
