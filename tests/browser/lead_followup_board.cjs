const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');

async function checkFollowUpBoard(browser, base, output) {
  const page = await browser.newPage({timezoneId:'Asia/Tokyo',reducedMotion:'reduce',viewport:{width:1400,height:900}});
  const get = async route => (await page.request.get(base+route)).json();
  const post = async (route, data) => {
    const response = await page.request.post(base+route,{data});
    assert.ok(response.ok(),await response.text());
    return response.json();
  };
  try {
    const organization = await get('/api/scheduler/organization');
    await post('/api/projects/link-folder',{});
    await post('/api/scheduler/organization',{version:organization.version,timezone:'America/New_York'});
    const directory = '/api/contacts/directory?board=1';
    for(const [name,status,date] of [
      ['Past','New','2027-03-13'],['Today','Qualified','2027-03-14'],['Tomorrow','Qualified','2027-03-15'],
      ['Later','New','2027-03-16'],['Unscheduled','New',''],['Disqualified','Disqualified','2027-03-14'],['Converted','Qualified','2027-03-13']
    ]){
      const fields={name:'Reminder '+name,company:'Reminder company '+name,status,follow_up_date:date};
      if(name==='Converted')Object.assign(fields,{phone:'0400000002',email:'reminder@example.test',site_address:'Fixture site'});
      const lead=await post('/api/contacts/leads',{version:(await get(directory)).version,fields});
      if(name==='Converted')await post('/api/contacts/leads/convert',{version:lead.version,id:lead.id});
    }
    const original=await get(directory);
    await page.goto(base);
    await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await page.clock.install({time:new Date('2027-03-15T03:58:00Z')});
    await page.locator('button[data-view="contacts"]').click();
    const root=page.locator('#contacts-root'),card=name=>root.locator('.contacts-board article').filter({hasText:'Reminder '+name});
    const due=name=>card(name).getByRole('img',{name:'Follow-up due',exact:true});
    await expect(card('Tomorrow')).toBeVisible();
    await page.clock.pauseAt(new Date('2027-03-15T03:59:58Z'));
    for(const name of ['Past','Today','Disqualified','Converted']){
      await expect(due(name)).toBeVisible();
      await expect(due(name)).toHaveText('!');
      await expect(due(name)).toHaveCSS('font-weight','800');
      await expect(due(name)).toHaveCSS('color','rgb(217, 54, 71)');
      const marker=await due(name).boundingBox(), tile=await card(name).boundingBox();
      assert.ok(Math.abs(tile.x+tile.width-marker.x-marker.width)<=16 && marker.y-tile.y<=16);
    }
    for(const name of ['Unscheduled','Tomorrow','Later'])await expect(due(name)).toHaveCount(0);
    const menu=card('Tomorrow').getByText('▾',{exact:true});
    await menu.click();await expect(card('Tomorrow').getByRole('button',{name:'Edit',exact:true})).toBeVisible();
    await page.clock.fastForward(2000);
    await expect(due('Tomorrow')).toBeVisible();
    await expect(card('Tomorrow').getByRole('button',{name:'Edit',exact:true})).toBeVisible();
    await expect(due('Later')).toHaveCount(0);await expect(due('Unscheduled')).toHaveCount(0);
    await menu.click();
    await root.getByRole('searchbox').fill('Reminder');
    await page.screenshot({path:path.join(output,'lead-follow-up.png')});
    await page.evaluate(()=>window.CeasefireI18n.setLanguage('fr',false));
    await expect(card('Tomorrow').getByRole('img',{name:'Suivi à effectuer',exact:true})).toBeVisible();
    await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
    for(const width of [1915,913,390]){
      await page.setViewportSize({width,height:884});
      const sizes=[];
      for(const [tab,name] of [['Contacts','New Contact'],['Companies','New Company'],['Leads','New Lead']]){
        await root.locator('.contacts-tabs').getByRole('button',{name:tab,exact:true}).click();
        const box=await root.getByRole('button',{name,exact:true}).boundingBox();
        sizes.push([box.width,box.height]);
      }
      assert.deepEqual(sizes,[sizes[0],sizes[0],sizes[0]]);
      assert.equal(sizes[0][0],sizes[0][1]);
    }
    assert.deepEqual(await get(directory),original);
  } finally {await page.close();}
}
module.exports={checkFollowUpBoard};
