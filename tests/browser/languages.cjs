// Real rendered language switching uses only a disposable, isolated fixture.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseTakeoff}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`languages-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[],evidence={languages:[],requests:[]};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function settings(){await page.locator('nav [data-view="settings"]').click();await expect(page.locator('#view-settings')).toBeVisible();}
async function snapshot(){await idle();return page.evaluate(()=>({project:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),penetrations:window.CeasefirePenetrations.projectSnapshot(),takeoffs:window.CeasefireTakeoffs.projectSnapshot(),inputs:[...document.querySelectorAll('#main-estimate-form input,#main-estimate-form select,#main-estimate-form textarea')].map(el=>[el.id,el.type,el.value,el.checked]),totals:[...document.querySelectorAll('[id^="sum-"]')].map(el=>[el.id,el.textContent])}));}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);evidence.port=fixture.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1366,height:1000}});
 page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))evidence.requests.push({method:r.method(),url:r.url()});});
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 await expect(page.locator('.home-laser-art')).toHaveAttribute('src','/home-steel-frame.png');
 await expect.poll(()=>page.locator('.home-laser-art').evaluate(el=>el.naturalWidth)).toBe(1122);
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});
 await chooseTakeoff(page,'Steel');await idle();
 await page.locator('nav [data-view="estimate"]').click();await idle();
 await page.locator('#project-no').fill('CF-LANGUAGE');await page.locator('#client').fill('Home');await page.locator('#site-address').fill('原始ข้อมูล العربية हिन्दी <literal>');await page.locator('#site-address').blur();await idle();
 const baseline=await snapshot();await settings();
 const languages=[['en','Language','Settings'],['zh-Hans','语言','设置'],['hi','भाषा','सेटिंग्स'],['es','Idioma','Configuración'],['ar','اللغة','الإعدادات'],['th','ภาษา','การตั้งค่า']];
 for(const [locale,heading,settingsName] of languages){
  const before=evidence.requests.length;await page.locator('#application-language').selectOption(locale);
  await expect(page.locator('#language-heading')).toHaveText(heading);await expect(page.locator('html')).toHaveAttribute('lang',locale==='en'?'en-AU':locale);await expect(page.locator('html')).toHaveAttribute('dir',locale==='ar'?'rtl':'ltr');
  await expect(page.locator('nav [data-view="settings"]')).toHaveAttribute('aria-label',settingsName);
  assert.equal(evidence.requests.length,before,'language preference sends no mutation requests');
  if(locale==='ar')for(const id of ['company-phone','company-abn'])await expect(page.locator('#'+id)).toHaveCSS('direction','ltr');
  await page.locator('nav [data-view="estimate"]').click();await idle();assert.deepEqual(await snapshot(),baseline,'language changes preserve project inputs, canonical values and totals');
  if(locale==='en')await expect(page.locator('#estimate-heading')).toHaveText('Estimate');
  if(locale==='zh-Hans'){
   await expect(page.locator('#estimate-heading')).toHaveText('估算');
   await expect(page.locator('#view-estimate .calculator-document-toggle')).toContainText('文件');
   await expect(page.locator('#main-panel-materials > p.helper')).toHaveCount(0);
   const previousOutput=await page.locator('#main-output-tabs [aria-selected="true"]').getAttribute('id');
   await page.locator('#main-tab-firestopping-breakdown').click();
   const breakdown=page.locator('#penetration-schedule-breakdown');
   for(const label of ['板材','防火圈','密封胶','框架','防火包裹材料','其他','附加人工','登记工时预留'])await expect(breakdown.getByText(label,{exact:true})).toBeVisible();
   await expect(breakdown.locator('.penetration-breakdown-note')).toHaveCount(0);
   await page.screenshot({path:path.join(output,'zh-estimate-tables.png')});
   if(previousOutput)await page.locator('#'+previousOutput).click();
   assert.deepEqual(await snapshot(),baseline,'Mandarin table labels preserve project values and totals');
   evidence.mandarinTables={taskRows:true,documentButton:true,notesRemoved:true,canonicalStateUnchanged:true};
  }
  if(locale==='ar')await expect(page.locator('#input-B28')).toHaveCSS('direction','ltr');
  await expect(page.locator('#client')).toHaveValue('Home');
  await settings();const screenshot=path.join(output,`${locale}-settings.png`);await page.screenshot({path:screenshot});
  evidence.languages.push({locale,heading,dir:await page.locator('html').getAttribute('dir'),screenshot});
 }
 // Create UI after the language has changed; the canonical input values remain English.
 await page.evaluate(()=>{const probe=document.createElement('p');probe.id='language-source-collision-probe';document.body.append(probe);window.CeasefireI18n.text(probe,'Home');probe.textContent='Home';});
 await page.locator('#application-language').selectOption('es');
 await expect(page.locator('#language-source-collision-probe')).toHaveText('Home');
 await page.locator('#language-source-collision-probe').evaluate(el=>el.remove());
 await page.locator('#takeoff-navigation-toggle').hover();await page.locator('#takeoff-navigation-menu [data-mode="steel"]').click();await idle();
 await expect(page.locator('.takeoff-viewport')).toHaveCSS('direction','ltr');
 const spanish=await page.locator('#view-takeoffs').innerText();assert.match(spanish,/Acero|acero/);assert.match(spanish,/Subir|Cargar/);
 await settings();await page.locator('#application-language').selectOption('ar');
 await page.locator('#takeoff-navigation-toggle').hover();await page.locator('#takeoff-navigation-menu [data-mode="steel"]').click();await idle();
 await expect(page.locator('.takeoff-viewport')).toHaveCSS('direction','ltr');await page.screenshot({path:path.join(output,'ar-drawing-direction.png')});
 await settings();await page.locator('#application-language').selectOption('th');await page.reload();await idle();await settings();await expect(page.locator('#application-language')).toHaveValue('th');await expect(page.locator('#language-heading')).toHaveText('ภาษา');
 await page.locator('#application-language').selectOption('en');await expect(page.locator('#language-heading')).toHaveText('Language');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({...evidence,errors,passed:true},null,2));console.log(`Languages passed: all six locales, immediate updates, canonical state, dynamic Takeoffs, Arabic drawing direction, reload persistence. ${output}`);
})().catch(async e=>{console.error(e);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
