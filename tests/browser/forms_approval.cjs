'use strict';
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),path=require('node:path');

(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<main></main>');
    for(const script of ['dates.js','form-controls.js','form-rich-text.js','form-fields.js'])
      await page.addScriptTag({path:path.resolve(__dirname,'../../static',script)});
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const template={mode:'workflow',settings:{stages:[{id:'first'},{id:'review'}]},fields:[
      {id:'before',type:'text',label:'Before approval'},
      {id:'one',type:'approval',label:'First approval'},
      {id:'middle',type:'text',label:'After first approval'},
      {id:'two',type:'approval',label:'Second approval'},
      {id:'last',type:'text',label:'After second approval'},
      {id:'review',type:'text',label:'Later stage',stage_id:'review'}
    ]};
    async function mount(values={},extra={}) {
      await page.evaluate(({template,image,values,extra})=>{
        window.profileCalls=0;
        window.form=window.ClassifireFormFields.mount(document.querySelector('main'),template,{
          values,stageId:'first',member:{id:'worker',name:'Login name'},...extra,
          signerProfile:async()=>{
            window.profileCalls++;
            return {id:'worker',name:'Settings full name',at:'2026-11-18T09:00:00.000Z',signature_image:image};
          }
        });
      },{template,image,values,extra});
    }
    const field=id=>page.locator('[data-field-id="'+id+'"]');
    await mount();
    await expect(field('before').locator('input')).toBeEditable();
    await expect(field('one').locator('input')).toBeEnabled();
    for(const id of ['middle','two','last','review']) await expect(field(id).locator('input')).toHaveCount(0);
    await field('one').locator('input').check();
    await expect(field('one')).toContainText('Settings full name');
    await expect(field('one').locator('img')).toHaveAttribute('src',image);
    await expect(field('middle').locator('input')).toBeEditable();
    await expect(field('two').locator('input')).toBeEnabled();
    await expect(field('last').locator('input')).toHaveCount(0);
    await field('middle').locator('input').fill('Ready for next approval');
    await field('two').locator('input').check();
    await expect(field('last').locator('input')).toBeEditable();
    await expect(field('review').locator('input')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.profileCalls),2);
    const values=await page.evaluate(()=>window.form.getValues());
    assert.equal(values.one,true);assert.equal(values.two,true);
    assert.equal(values.middle,'Ready for next approval');
    assert.equal(await page.evaluate(()=>window.form.isBusy()),false);
    const signed={member_id:'worker',member_name:'Settings full name',at:'2026-11-18T09:00:00.000Z',signature_image:image};
    await mount({...values,one:signed,two:signed});
    await expect(field('one').locator('input')).toBeDisabled();
    await expect(field('one').locator('img')).toHaveAttribute('src',image);
    await expect(field('middle').locator('input')).toBeEditable();
    await mount({...values,one:signed,two:signed},{stageId:'review',lockedStages:['first']});
    await expect(field('middle').locator('input')).toHaveCount(0);
    await expect(field('review').locator('input')).toBeEditable();
    await mount({...values,one:true,two:true},{readOnly:true});
    await expect(field('one')).toContainText('Approved');
    await expect(field('one').locator('img')).toHaveCount(0);
    console.log('PASS Approval Settings identity and ink, sequential locks, immutable signed fields, stage locks and historical approval display.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
