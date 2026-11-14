'use strict';
const {chromium, expect}=require('@playwright/test');
const assert=require('node:assert/strict'),path=require('node:path');
const asset=name=>path.resolve(__dirname,'../../static',name);

async function nativeFields(page) {
  // Compare the actual layout of Chromium's date segments, including the separators.
  const devtools=await page.context().newCDPSession(page);
  try {
    const root=(await devtools.send('DOM.getDocument',{depth:-1,pierce:true})).root;
    const fields=[];
    async function walk(node) {
      const attrs=node.attributes || [],index=attrs.indexOf('pseudo');
      if(index>=0 && (attrs.includes('spinbutton') || attrs[index+1]==='-webkit-datetime-edit-text')) {
        const box=await devtools.send('DOM.getBoxModel',{nodeId:node.nodeId});
        fields.push({text:node.children?.[0]?.nodeValue,x:box.model.border[0]});
      }
      for(const child of [...node.children || [],...node.shadowRoots || []]) await walk(child);
    }
    await walk(root);
    return fields.sort((a,b)=>a.x-b.x).map(field=>field.text).join('');
  } finally {await devtools.detach();}
}

(async()=>{
  const browser=await chromium.launch();
  try {
    for(const locale of ['en-US','en-AU','de-DE','ar-EG']) {
      const page=await browser.newPage({locale,timezoneId:'America/Los_Angeles'});
      await page.setContent('<form><label id="caption" for="due">Inspection due</label><input id="due" name="due" type="date" aria-labelledby="caption" value="2026-11-23" max="2100-12-31"></form>');
      await page.addScriptTag({path:asset('dates.js')});
      await page.addStyleTag({path:asset('date-controls.css')});
      await page.addScriptTag({path:asset('date-controls.js')});
      const result=await page.evaluate(()=>{
        const {date,dateTime,wallTime,parseDate}=window.ClassifireDates;
        return [date('2024-02-29'),dateTime('2024-02-29T01:04:05Z'),dateTime('2024-02-29T01:04:05Z',{timeZone:'Australia/Sydney',seconds:false}),
          wallTime('2026-04-05T02:30:12.345+11:00'),wallTime('2026-04-05T02:30:12.345+10:00'),parseDate('29/02/2100'),parseDate('29/02/2000')];
      });
      assert.deepEqual(result,['29/02/2024','28/02/2024 17:04:05','29/02/2024 12:04','05/04/2026 02:30:12.345+11:00','05/04/2026 02:30:12.345+10:00','','2000-02-29']);
      const due=page.getByRole('textbox',{name:'Inspection due',exact:true});
      await expect(due).toHaveCount(1);
      if(!(await page.locator('.date-text').count())) {
        assert.equal(await nativeFields(page),'23/11/2026');
        await due.focus();await page.keyboard.type('17');await expect(due).toHaveValue('2026-11-17');
        await due.fill('2100-12-31');await expect(due).toHaveValue('2100-12-31');
      } else {
        const calendar=page.getByRole('textbox',{name:'Choose date · Inspection due',exact:true});
        await expect(due).toHaveValue('23/11/2026');await expect(calendar).toHaveCount(1);
        await page.locator('label').click();await expect(due).toBeFocused();
        await due.fill('29/02/2100');assert.equal(await page.locator('form').evaluate(f=>f.checkValidity()),false);
        await due.fill('29/02/2000');await due.press('Tab');
        assert.equal(await page.locator('form').evaluate(f=>new FormData(f).get('due')),'2000-02-29');
        await calendar.fill('2100-12-31');await expect(due).toHaveValue('31/12/2100');
        await due.fill('2028-02-29');await expect(due).toHaveValue('29/02/2028');
        await due.fill('2027-02-29');assert.equal(await due.evaluate(input=>input.checkValidity()),false);
        await page.locator('#due').evaluate(input=>{input.value='2024-03-02';});
        await expect(due).toHaveValue('02/03/2024');
        await page.evaluate(()=>{const input=document.createElement('input');input.type='datetime-local';input.id='shift';input.setAttribute('aria-label','Shift start');
          input.step='any';document.querySelector('form').append(input);
          window.changes=0;input.addEventListener('change',()=>++window.changes);
        });
        const start=page.getByRole('textbox',{name:'Shift start',exact:true});
        await start.fill('01/03/2026 00:02:03.456');await start.press('Tab');
        await expect(page.locator('#shift')).toHaveValue('2026-03-01T00:02:03.456');
        assert.equal(await page.evaluate(()=>window.changes),1);
        await page.evaluate(()=>document.querySelector('form').reset());await expect(due).toHaveValue('23/11/2026');
      }
      await page.close();
    }
    console.log('Workspace dates passed in en-AU, en-US, de-DE and ar-EG, including calendar order, canonical input values, DST offsets and timezone boundaries.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
