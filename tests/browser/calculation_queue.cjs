"use strict";
// Only synthetic drafts in a disposable random-port fixture.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`calculation-queue-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,release;const errors=[],checks=[];
server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.on('error',reject);});
const idle=async()=>{await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy&&!window.CeasefireActivity.active);};
async function burst(pattern,field,readValue){
  const sent=[],held=new Promise(resolve=>release=resolve);
  await page.route(pattern,async route=>{sent.push(route.request().postDataJSON());if(sent.length===1)await held;await route.continue();});
  await field.fill('1.123456789');await field.press('Tab');await expect.poll(()=>sent.length).toBe(1);
  await field.fill('2.123456789');await field.press('Tab');await page.waitForTimeout(650);
  await field.fill('3.123456789');await field.press('Tab');await page.waitForTimeout(650);
  assert.equal(sent.length,1);await expect(page.locator('html')).toHaveAttribute('aria-busy','true');
  release();await expect.poll(()=>sent.length).toBe(2);await idle();
  assert.equal(readValue(sent[1]),3.123456789);assert.equal(sent.length,2);
  await field.focus();await expect(field).toHaveValue('3.123456789');await field.press('Tab');
  await page.unroute(pattern);checks.push({pattern,sent:sent.length,latest:readValue(sent[1])});
}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
  const base=`http://127.0.0.1:${info.port}`;
  const seed=await page.request.put(`${base}/api/calculators/steel_board/state`,{data:{inputs:{CALCULATOR:{A9:'QUEUE FIXTURE',C9:'PROMATECT-XS',D9:'200UC46',F9:1,G9:4,H9:120,I9:'Column',J9:550}},schedule_rows:[9]}});assert.equal(seed.status(),200);
  await page.goto(base);await idle();await chooseCalculator(page,'Steel (board)');await idle();await page.getByRole('button',{name:'SCHEDULE',exact:true}).click();await idle();
  await burst('**/api/calculators/steel_board/worksheet',page.locator('[data-calculator-cell="F9"]'),body=>body.inputs.CALCULATOR.F9);
  await page.screenshot({path:path.join(output,'steel-latest.png')});
  await chooseCalculator(page,'Firestopping');await idle();
  await burst('**/api/penetration/calculate',page.locator('#penetration-item-quantity [data-penetration-field="O"]'),body=>body.draft.rows[0].inputs.O);
  await page.screenshot({path:path.join(output,'firestopping-latest.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(`PASS calculation queue: ${output}`);
})().catch(async error=>{console.error(error);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{release?.();fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
