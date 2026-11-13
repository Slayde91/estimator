const { expect } = require('@playwright/test');
const path = require('node:path');

async function checkProjectSidebarScrolling(page, open, close, output) {
  const people = {accounts: 'Company', contacts: 'Contact'};
  const directory = {accounts: [], contacts: []}, participants = [];
  const events = Array.from({length: 28}, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), label: 'Project file modified',
    subject: 'Activity ' + i + (i === 26 ? ' with a longer description that wraps across several lines'.repeat(4) : '')
  }));
  // Keep the normal panel, directory search and card renderers. Provide deterministic
  // versions of the selected project's records, including a primary with a second role.
  const fixtures = [];
  async function fixture(pattern, adapt) {
    await page.route(pattern, async route => {
      const original = await route.fetch();
      await route.fulfill({response: original, json: adapt(await original.json())});
    });
    fixtures.push(pattern);
  }
  const primary = {accounts:'synthetic-primary-company',contacts:'synthetic-primary-contact'};
  for (const [kind,label] of Object.entries(people)) {
    for (const [index,id] of ['secondary-' + kind, primary[kind], 'third-' + kind].entries()) {
      const name = label + ' ' + index;
      directory[kind].push({id, company: kind === 'accounts' ? name : 'Company 1', name,
        title: 'Project coordinator', phone: '0400 000 001', email: 'contact@example.test',
        billing_address: 'Level 2, a business centre with a long address and delivery instructions'.repeat(3)});
      participants.push({kind, id, label:name, role:kind==='accounts'?'consultant':'site_contact'});
    }
  }
  await fixture('**/api/projects/details', data => ({...data, details:{...data.details,account_id:'prior-company-id',contact_id:primary.contacts}}));
  await fixture('**/api/contacts/directory', data => ({...data,accounts:[...directory.accounts,...data.accounts],contacts:[...directory.contacts,...data.contacts],
    identity_aliases:{...data.identity_aliases,accounts:{...data.identity_aliases?.accounts,'prior-company-id':primary.accounts}}}));
  await fixture('**/api/crm/project-participants?*', data => ({...data,participants,linked_parties:[]}));
  await fixture('**/api/crm/project-activity?*', () => ({events}));
  const accounts=page.locator('#project-company-participants .project-party-cards');
  const contacts=page.locator('#project-contact-participants .project-party-cards');
  const history=page.locator('#project-workspace-side .record-activity-history'), activity=history.locator('ol');
  async function geometry(list, count) {
    return list.evaluate((el,n) => {
      const first=el.children[0].getBoundingClientRect(), last=el.children[n-1].getBoundingClientRect(), next=el.children[n]?.getBoundingClientRect();
      const box=el.getBoundingClientRect();return {height:box.height, target:last.bottom-first.top, firstTop:first.top-box.top,
        nextTop:next?.top-box.top, scrollable:el.scrollHeight>el.clientHeight};
    },count);
  }
  async function fits(list, count) {
    await expect.poll(async()=>{
      const g=await geometry(list,count);
      return g.scrollable && Math.abs(g.height-g.target)<1 && Math.abs(g.firstTop)<1 && g.nextTop>=g.height;
    }).toBe(true);
  }
  const results = [];
  try {
    await open();await expect(accounts.locator('li')).toHaveCount(3);await expect(contacts.locator('li')).toHaveCount(3);
    await expect(accounts.locator('li').first()).toContainText('Main Client');
    await expect(contacts.locator('li').first()).toContainText('Primary contact');
    await history.locator('summary').click();await expect(activity.locator('li')).toHaveCount(25);
    await expect(activity.locator('li').first()).toContainText('Activity 27');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:884});
      for (const [key,list,count] of [['accounts',accounts,1],['contacts',contacts,1],['activity',activity,5]]) {
        await list.evaluate(el=>el.scrollTop=0);await fits(list,count);results.push({key,width,...await geometry(list,count)});
        await expect(list).toHaveAttribute('tabindex','0');
      }
    }
    const firstCard=accounts.locator('li').first(), initial=(await geometry(accounts,1)).height;
    await firstCard.locator('dd').first().evaluate(el=>el.textContent+='\nAnother line'.repeat(5));
    await expect.poll(async()=>(await geometry(accounts,1)).height).toBeGreaterThan(initial+20);await fits(accounts,1);
    await accounts.focus();await accounts.press('End');await expect.poll(()=>accounts.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    await expect(contacts).toHaveJSProperty('scrollTop',0);await expect(activity).toHaveJSProperty('scrollTop',0);
    await activity.hover();await page.mouse.wheel(0,450);await expect.poll(()=>activity.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    await history.getByRole('button',{name:'Load earlier activity'}).click();await expect(activity.locator('li')).toHaveCount(28);
    await activity.focus();await activity.press('End');await expect(activity.locator('li').last()).toContainText('Activity 0');
    await expect.poll(()=>activity.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(2);
    for (const [name,list] of [['company',accounts],['contact',contacts],['activity',activity]]) {
      await list.evaluate(el=>{
        el.scrollTop=0;
        const header=document.querySelector('.app-header').getBoundingClientRect();
        window.scrollBy({top:el.getBoundingClientRect().top-header.bottom-12,behavior:'instant'});
      });
      await list.screenshot({path:path.join(output,'project-sidebar-'+name+'.png')});
    }
    for (const retained of [4,0]) {
      await history.locator('summary').click();events.splice(retained);await history.locator('summary').click();
      if(retained)await expect(activity.locator('li')).toHaveCount(retained);
      else await expect(history).toContainText('No activity recorded.');
      await expect(activity).not.toHaveAttribute('tabindex','0');
      await expect.poll(()=>activity.evaluate(el=>el.scrollHeight-el.clientHeight)).toBe(0);
      if(!retained)await expect(activity).toBeHidden();
    }
    return results;
  } finally {
    for (const pattern of fixtures) await page.unroute(pattern);
    await page.setViewportSize({width:1915,height:884});await close();
  }
}
module.exports = {checkProjectSidebarScrolling};
