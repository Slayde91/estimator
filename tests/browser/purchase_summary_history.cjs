const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');

async function checkHistoryWindow(panel, visibleRows) {
  const list = panel.locator('ol'), items = list.locator('li');
  const count = await items.count();
  assert.ok(count >= visibleRows);
  await list.evaluate(el => { el.scrollTop = 0; });
  await expect.poll(() => list.evaluate((el, visible) => {
    const box = el.getBoundingClientRect();
    const first = el.children[0].getBoundingClientRect();
    const last = el.children[visible - 1].getBoundingClientRect();
    const next = el.children[visible]?.getBoundingClientRect();
    return Math.abs(box.top - first.top) < 1 && Math.abs(box.bottom - last.bottom) < 1 && (!next || next.top >= box.bottom);
  }, visibleRows)).toBe(true);
  if(count > visibleRows) {
    await expect(list).toHaveAttribute('tabindex','0');
    await list.focus();await list.press('End');
    await expect.poll(()=>list.evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop))).toBeLessThan(2);
  } else {
    await expect(list).not.toHaveAttribute('tabindex','0');
    assert.equal(await list.evaluate(el=>el.scrollHeight-el.clientHeight),0);
  }
}

async function checkPurchaseSummary(page, purchase, id, output) {
  const totals=purchase.locator('.commercial-purchase-summary > .commercial-totals'), history=purchase.locator('.record-activity-history');
  const summary=history.locator('summary'), list=history.locator('ol'), rows=list.locator('li');
  const allEvents=Array.from({length:28},(_,i)=>({at:new Date(Date.UTC(2026,0,1,i)).toISOString(),label:'Updated',
    subject:'Event '+i+(i===25?' with a long supplier description and delivery details'.repeat(4):'')}));
  let events=allEvents;
  const activityRoute='**/api/commercial/activity?*';
  await page.route(activityRoute,route=>new URL(route.request().url()).searchParams.get('document')===id
    ?route.fulfill({json:{events}}):route.continue());
  try {
    await summary.click();await expect(rows).toHaveCount(25);
    await expect(rows.first()).toContainText('Event 27');
    for(const width of [1600,390]) {
      await page.setViewportSize({width,height:1000});
      await expect(totals).toHaveCSS('height','187px');
      await expect(totals).toHaveCSS('border-top-width','3px');await expect(totals).toHaveCSS('border-top-style','solid');
      await expect(totals).toHaveCSS('border-top-color',await totals.evaluate(el=>{
        const probe=document.createElement('span');probe.style.color='var(--red)';el.append(probe);
        const color=getComputedStyle(probe).color;probe.remove();return color;
      }));
      await checkHistoryWindow(history,5);
      await totals.screenshot({path:path.join(output,'purchase-totals-'+width+'.png')});
    }
    const label=totals.locator('strong').first(), original=await label.textContent();
    await label.evaluate(el=>{el.textContent='Long translated totals label '.repeat(30);});
    assert.ok((await totals.boundingBox()).height>187);
    assert.equal(await totals.evaluate(el=>el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1),true);
    await label.evaluate((el,value)=>{el.textContent=value;},original);
    await list.evaluate(el=>el.scrollTop=0);
    const previous=(await list.boundingBox()).height;
    await rows.nth(1).locator('p').last().evaluate(el=>{el.textContent+='Additional delivery details. '.repeat(22);});
    await expect.poll(async()=>(await list.boundingBox()).height).toBeGreaterThan(previous+20);
    await checkHistoryWindow(history,5);
    await history.getByRole('button',{name:'Load earlier activity'}).click();await expect(rows).toHaveCount(28);
    await checkHistoryWindow(history,5);await expect(rows.last()).toContainText('Event 0');
    for(const count of [5,3,0]) {
      await summary.click();events=allEvents.slice(0,count);await summary.click();
      await expect(rows).toHaveCount(count);
      if(count)await checkHistoryWindow(history,count);
      else {await expect(history).toContainText('No activity recorded.');await expect(list).toBeHidden();}
    }
  } finally {
    if(await history.evaluate(el=>el.open))await summary.click();
    await page.unroute(activityRoute);
    await page.setViewportSize({width:1600,height:1000});
  }
}
module.exports={checkPurchaseSummary,checkHistoryWindow};
