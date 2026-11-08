// Disposable server coverage for durable shared rates and protected quote snapshots.
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {clickProjectControl, fillProjectDetails, openProjectSection} = require('./project_actions.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `commercial-rate-defaults-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs='', browser, page, releaseHeld;
server.stderr.on('data', value => logs += value);
const ready = new Promise((resolve, reject) => {
  let data=''; const timer=setTimeout(() => reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data', value => {data+=value; if (data.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error', reject);
  server.once('exit', code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}`));});
});
const checks=[], errors=[];
async function idle() {
  await page.waitForFunction(() => {const value=window.CeasefireDesktop?.status(); return value?.ready && !value.busy;});
}
async function rates() {
  const response=await page.request.get(new URL('/api/commercial/rate-defaults',page.url()).href);
  assert.equal(response.status(),200); return response.json();
}
async function saveQuote(host) {
  await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(host.locator('.commercial-message')).toContainText('Document saved.');
}
async function discardQuote(host) {
  await host.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  await expect(host.getByRole('button',{name:'New Quote',exact:true})).toBeVisible();
}
(async () => {
  const info=await ready;
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1915,height:1000}});
  page.setDefaultTimeout(45000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  await fillProjectDetails(page,{client:'Durable rates account','site-address':'7 Rate Street'});
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await page.locator('#project-estimate-quote').click();
  const quote=page.locator('#commercial-quote-root');
  await expect(quote.getByLabel('Ordinary time',{exact:true})).toHaveValue('130');
  await quote.getByLabel('Document title',{exact:true}).fill('Protected original quote');

  // The trash icon sits at the right of the editable description, with no new column.
  const rows=quote.locator('.commercial-lines tbody tr');
  const linkedDescription=await rows.first().getByRole('textbox').inputValue();
  const linkedPrice=await rows.first().locator('input').last().inputValue();
  const originalTotals=await quote.locator('.commercial-totals').innerText();
  await expect(rows.first().getByRole('button',{name:'Remove row',exact:true})).toHaveCount(0);
  await quote.locator('.commercial-estimate-picker summary').click();
  await quote.getByRole('button',{name:'Add custom row',exact:true}).click();
  const custom=rows.last(), remove=custom.getByRole('button',{name:'Remove row',exact:true});
  await custom.getByRole('textbox').fill('Temporary custom amount');
  await custom.locator('input').first().fill('2'); await custom.locator('input').last().fill('100');
  await expect(custom.locator('.commercial-line-total')).toHaveText('$200.00');
  await expect(remove.locator('svg')).toHaveCount(1);
  assert.equal(await remove.innerText(),'');
  const geometry=await remove.evaluate(button => {
    const cell=button.closest('td'), editor=cell.querySelector('textarea');
    const a=button.getBoundingClientRect(), b=editor.getBoundingClientRect(), c=cell.getBoundingClientRect();
    return {button:{x:a.x,y:a.y,width:a.width,height:a.height,right:a.right},editor:{x:b.x,y:b.y,right:b.right},cell:{right:c.right,columns:cell.parentElement.children.length}};
  });
  assert.equal(geometry.cell.columns,4);
  assert.ok(Math.abs(geometry.button.y-geometry.editor.y)<2);
  assert.ok(geometry.button.x>=geometry.editor.right && geometry.cell.right-geometry.button.right<=12);
  assert.ok(geometry.button.width>=40 && geometry.button.height>=40);
  await custom.screenshot({path:path.join(output,'custom-row-inline.png')});
  await remove.click(); await expect(rows).toHaveCount(1);
  assert.equal(await rows.first().getByRole('textbox').inputValue(),linkedDescription);
  assert.equal(await rows.first().locator('input').last().inputValue(),linkedPrice);
  assert.equal(await quote.locator('.commercial-totals').innerText(),originalTotals);
  checks.push('custom-row trash stays in description cell, removes its amount and preserves generated estimate line');
  await saveQuote(quote);
  const savedResponse=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page,'Save'); assert.equal((await savedResponse).status(),200); await idle();
  const originalFile=fs.readFileSync(info.project,'utf8');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  const card=quote.locator('.commercial-card').filter({hasText:'Protected original quote'});
  const updated=await card.locator('dt').filter({hasText:/^Updated$/}).locator('xpath=following-sibling::dd[1]').innerText();
  assert.match(updated,/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
  await card.getByRole('button',{name:'Protected original quote',exact:true}).click();
  const ordinary=quote.getByLabel('Ordinary time',{exact:true});

  // A delayed response must not clear or replace edits made after its request.
  let release, heldResolve;
  const held=new Promise(resolve=>heldResolve=resolve), releasePromise=new Promise(resolve=>release=releaseHeld=resolve);
  let holdOnce=true;
  await page.route('**/api/commercial/rate-defaults',async route => {
    if (route.request().method()!=='POST' || !holdOnce) return route.continue();
    holdOnce=false; const response=await route.fetch(); heldResolve(); await releasePromise; await route.fulfill({response});
  });
  await ordinary.fill('141');
  let heldTimer;
  try { await Promise.race([held, new Promise((_,reject)=>heldTimer=setTimeout(()=>reject(Error('Rate autosave was not sent')),30000))]); }
  finally { clearTimeout(heldTimer); }
  await ordinary.fill('142'); await quote.getByLabel('Materials',{exact:true}).fill('26');
  release();
  await expect.poll(async()=>JSON.stringify((await rates()).rates)).toContain('"ordinary_time":"142"');
  await expect.poll(async()=>(await rates()).rates.materials).toBe('26');
  await expect(ordinary).toHaveValue('142');
  await expect(quote.locator('.commercial-rate-defaults-status')).toHaveText('Rates remembered for new documents.');
  await page.unroute('**/api/commercial/rate-defaults');
  checks.push('delayed autosave serializes newer edits without replacing editor values');

  const validProfile=await rates();
  for (const invalid of ['', '-1', '1.0000001']) {
    await ordinary.fill(invalid);
    await expect(quote.locator('.commercial-rate-defaults-status')).toContainText('Enter a rate');
    await page.waitForTimeout(350);
    assert.deepEqual(await rates(),validProfile);
  }
  await ordinary.fill('142'); await ordinary.blur();
  await expect(quote.locator('.commercial-rate-defaults-status')).toHaveText('Rates remembered for new documents.');
  const beforeIntro=await rates();
  await quote.getByLabel('Schedule of Rates introduction',{exact:true}).fill('Only this document introduction.');
  await page.waitForTimeout(350); assert.deepEqual(await rates(),beforeIntro);
  checks.push('invalid/partial amounts and introduction edits never overwrite durable numeric defaults');

  let failOnce=true;
  await page.route('**/api/commercial/rate-defaults',async route => {
    if (route.request().method()==='POST' && failOnce) {
      failOnce=false;
      const committed=await route.fetch(); assert.equal(committed.status(),200);
      return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic lost success response'})});
    }
    return route.continue();
  });
  await quote.getByLabel('Equipment',{exact:true}).fill('23');
  const retry=quote.getByRole('button',{name:'Retry remembering rates',exact:true});
  await expect(retry).toBeVisible();
  await expect(quote.locator('.commercial-rate-defaults-status')).toContainText('could not be saved');
  const committedProfile=await rates(); assert.equal(committedProfile.rates.equipment,'23');
  await retry.click(); await expect(retry).toBeHidden();
  assert.deepEqual(await rates(),committedProfile,'retry confirms a lost success without reporting a false failure or writing a second version');
  await page.unroute('**/api/commercial/rate-defaults');
  const baseline=await rates();
  const external=await page.request.post(new URL('/api/commercial/rate-defaults',page.url()).href,{data:{expected_version:baseline.version,rates:{double_time:'210',time_and_half:'177'}}});
  assert.equal(external.status(),200);
  await quote.getByLabel('Double time',{exact:true}).fill('205');
  await expect(retry).toBeVisible();
  await expect(quote.locator('.commercial-rate-defaults-status')).toContainText('another window');
  assert.equal((await rates()).rates.double_time,'210');
  await retry.click(); await expect(retry).toBeHidden();
  const finalProfile=await rates();
  assert.equal(finalProfile.rates.double_time,'205'); assert.equal(finalProfile.rates.time_and_half,'177');
  checks.push('failed saves remain retryable and explicit conflict retry preserves untouched rates from another window');

  await discardQuote(quote);
  assert.equal(fs.readFileSync(info.project,'utf8'),originalFile,'rate autosave never auto-writes the project file');
  await card.getByRole('button',{name:'Protected original quote',exact:true}).click();
  await expect(ordinary).toHaveValue('130');
  await expect(quote.getByLabel('Materials',{exact:true})).toHaveValue('20');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  for (const [key,value] of Object.entries(finalProfile.rates)) await expect(quote.locator(`[data-rate-key="${key}"]`)).toHaveValue(value);
  await discardQuote(quote);
  checks.push('discarded document edits keep shared defaults; existing saved snapshot remains unchanged and new draft uses all seven defaults');

  await openProjectSection(page,'quotes');
  await page.locator('.project-workspace-actions').getByRole('button',{name:'New',exact:true}).click();
  const prompt=page.locator('#discard-dialog');
  await page.waitForFunction(() => document.querySelector('#discard-dialog').open || window.CeasefireProject.context().project_path===null);
  if (await prompt.isVisible()) await prompt.getByRole('button',{name:'New project',exact:true}).click();
  await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),null);
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await page.locator('#project-estimate-quote').click();
  await expect(ordinary).toHaveValue('142'); await expect(quote.getByLabel('Time and a half',{exact:true})).toHaveValue('177');
  await discardQuote(quote);
  await page.reload(); await idle();
  await openProjectSection(page,'quote');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  for (const [key,value] of Object.entries(finalProfile.rates)) await expect(quote.locator(`[data-rate-key="${key}"]`)).toHaveValue(value);
  checks.push('new project and browser reload both use persisted app defaults rather than calculator pricing');
  await expect(quote.locator('.commercial-message')).toBeHidden();
  await quote.locator('.commercial-estimate-picker summary').click();
  await quote.getByRole('button',{name:'Add custom row',exact:true}).click();
  await quote.locator('.commercial-lines tbody tr').last().getByRole('textbox').fill('Custom row with inline trash');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'rates-and-custom-row.png'),fullPage:true});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,updated,profile:finalProfile,errors},null,2));
  console.log(`PASS commercial rate defaults. ${output}`);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{releaseHeld?.(); await browser?.close(); server.kill();});
