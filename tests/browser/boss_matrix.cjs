const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chooseLibrary}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa', 'boss-matrix-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'boss_matrix_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let browser,page,logs='';server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.on('error',reject);});
const errors=[],external=[];
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:900}});
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:'))external.push(r.url());});
 await page.goto('http://127.0.0.1:'+fixture.port+'/');await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);
 await chooseLibrary(page,'technical');await page.locator('[data-library-record="boss-bf-9001"]').click();
 const detail=page.locator('[data-library-detail="technical"]');await expect(detail).toBeVisible();
 const barrier=detail.locator('.library-record-field').filter({has:page.getByText('Barrier Construction',{exact:true})});
 await expect(barrier.locator('li')).toHaveCount(2);await expect(barrier).toContainText('90 mm');
 await expect(detail).toContainText('-/90/60 - RISF 24 min');await expect(detail).toContainText('min. diameter (mm): 0');
 await expect(detail).toContainText('exposed-side condition');await expect(detail).toContainText('Revision equivalence');
 const link=detail.getByRole('link',{name:'FAS990001 R2.0',exact:true});assert.equal(await link.getAttribute('href'),'https://bossfire.com/documents/test-reports/Synthetic-FAS990001.pdf');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
 await page.screenshot({path:path.join(output,'boss-fields.png'),fullPage:true});
 for(const width of [825,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await expect(barrier.locator('li')).toHaveCount(2);}
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,errors,external,syntheticOnly:true}));console.log('PASS BOSS matrix browser: '+output);
})().catch(async e=>{console.error(e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
