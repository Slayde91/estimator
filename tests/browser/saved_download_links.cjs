'use strict';
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
let activeBrowser;
(async()=>{
  const browser=activeBrowser=await chromium.launch({headless:true}),page=await browser.newPage();
  const errors=[],opened=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://notification.test/**',async route=>{
    const request=route.request();
    if(request.method()==='POST'){
      opened.push({url:request.url(),body:request.postData()});
      await route.fulfill({status:request.url().includes('D'.repeat(32))?400:200,contentType:'application/json',body:JSON.stringify(request.url().includes('D'.repeat(32))?{error:'The saved file changed, moved or was removed. Download it again.'}:{opened:true})});
    }else await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main></main></body></html>'});
  });
  await page.goto('http://notification.test/');
  await page.evaluate(()=>{window.CeasefireMessages={'Notice {0}':['','', 'Aviso {0}'],'The saved file changed, moved or was removed. Download it again.':['','','El archivo cambió. Descárguelo de nuevo.']};});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'static/language.js'),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'static/notifications.js'),'utf8')});
  await page.evaluate(()=>{
    window.receipt=(token,filename,path)=>({saved:true,destination:'project',filename,path,download_url:'/api/download-files/'+token.repeat(32),open_url:filename.endsWith('.xlsx')?'/api/download-files/'+token.repeat(32)+'/open':null});
    window.notice=(id,text)=>{let element=document.getElementById(id);if(!element){element=document.createElement('p');element.id=id;element.className='message info';document.querySelector('main').append(element);}window.CeasefireI18n.text(element,'Notice {0}',[text]);window.CeasefireNotifications.show(element);return element;};
    window.CeasefireNotifications.rememberDownload(receipt('A','Report.pdf','C:/Old/Report.pdf'));notice('old','Report.pdf');
  });
  await expect(page.locator('#old a')).toHaveAttribute('href','/api/download-files/'+'A'.repeat(32));
  await expect(page.locator('#old a')).toHaveAttribute('target','_blank');await expect(page.locator('#old a')).toHaveAttribute('rel','noopener');
  await page.evaluate(()=>{
    window.CeasefireNotifications.rememberDownload(receipt('B','Report.pdf','C:/New/Report.pdf'));
    window.CeasefireNotifications.rememberDownload(receipt('C','Costs.xlsx','C:/New/Costs.xlsx'));
    notice('new','Report.pdf and Costs.xlsx and Report.pdf');
    notice('exact','C:/Old/Report.pdf');
    window.CeasefireI18n.setLanguage('es',false);
  });
  await expect(page.locator('#old a')).toHaveAttribute('href','/api/download-files/'+'A'.repeat(32));
  await expect(page.locator('#new')).toContainText('Aviso Report.pdf and Costs.xlsx and Report.pdf');
  await expect(page.locator('#new a')).toHaveCount(3);await expect(page.locator('#new .notification-dismiss')).toHaveCount(1);
  assert.deepEqual(await page.locator('#new a').evaluateAll(items=>items.map(item=>item.getAttribute('href'))),['/api/download-files/'+'B'.repeat(32),'/api/download-files/'+'C'.repeat(32),'/api/download-files/'+'B'.repeat(32)]);
  await expect(page.locator('#exact a')).toHaveAttribute('href','/api/download-files/'+'A'.repeat(32));
  await page.locator('#new a').nth(1).click();await expect.poll(()=>opened.length).toBe(1);
  assert.deepEqual(opened[0],{url:'http://notification.test/api/download-files/'+'C'.repeat(32)+'/open',body:'{}'});
  await page.evaluate(()=>{notice('old','Report.pdf');window.CeasefireI18n.setLanguage('en',false);});
  await expect(page.locator('#old a')).toHaveAttribute('href','/api/download-files/'+'B'.repeat(32));
  await page.evaluate(()=>{
    window.CeasefireNotifications.rememberDownload(receipt('D','Missing.xlsx','C:/New/Missing.xlsx'));notice('missing','Missing.xlsx');
    window.CeasefireNotifications.rememberDownload({...receipt('E','Untrusted.pdf','C:/New/Untrusted.pdf'),download_url:'https://evil.test/file'});notice('untrusted','Untrusted.pdf');
    window.CeasefireNotifications.rememberDownload(receipt('F','<img src=x>.pdf','C:/New/<img src=x>.pdf'));notice('safe','<img src=x>.pdf');
  });
  await expect(page.locator('#untrusted a')).toHaveCount(0);await expect(page.locator('#safe img')).toHaveCount(0);await expect(page.locator('#safe a')).toHaveText('<img src=x>.pdf');
  await page.locator('#missing a').click();await expect(page.locator('p.error')).toContainText('The saved file changed');
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('es',false));await expect(page.locator('p.error')).toContainText('El archivo cambió');
  await page.locator('#new .notification-dismiss').click();await expect(page.locator('#new')).toBeHidden();
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await expect(page.locator('#new')).toBeHidden();
  await expect(page.locator('#old .notification-dismiss')).toHaveCount(1);assert.deepEqual(errors,[]);
  await page.evaluate(()=>notice('pdf-open','Report.pdf'));
  await page.context().route('http://notification.test/api/download-files/*',route=>route.fulfill({contentType:'text/html',body:'Saved PDF viewer test'}));
  const popup=page.waitForEvent('popup');await page.locator('#pdf-open a').click();const viewer=await popup;
  await expect(viewer).toHaveURL('http://notification.test/api/download-files/'+'B'.repeat(32));await viewer.close();

  // Actual application export: no mocked save response, file or notification.
  const output=path.join(root,'.runtime/browser-qa','saved-download-links-'+Date.now());fs.mkdirSync(output,{recursive:true});
  const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
  let logs='';server.stderr.on('data',data=>logs+=data);
  try{
    const info=await new Promise((resolve,reject)=>{let data='';const timeout=setTimeout(()=>reject(Error(logs||'Fixture startup timed out')),120000);server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error('Fixture exited '+code+': '+logs));});});
    assert.notEqual(info.port,8765);const app=await browser.newPage({viewport:{width:1915,height:1000}});
    app.on('pageerror',error=>errors.push(error.message));await app.goto('http://127.0.0.1:'+info.port);
    await app.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
    await app.getByRole('button',{name:'Libraries',exact:true}).hover();await app.getByRole('group',{name:'Choose a library',exact:true}).getByRole('button',{name:'Pricing Library',exact:true}).click();
    await app.locator('#pricing-scope').selectOption('library');
    await app.locator('.pricing-document-menu [data-document-menu-toggle]').click();
    const exported=app.waitForResponse(response=>new URL(response.url()).pathname==='/api/pricing/export'&&response.request().method()==='POST');
    await app.locator('#export-pricing').click();const response=await exported;assert.equal(response.status(),200,await response.text());const receipt=await response.json();
    assert.equal(receipt.destination,'downloads');assert.ok(fs.statSync(receipt.path).size>0);assert.equal(fs.readFileSync(receipt.path).subarray(0,2).toString(),'PK');
    const file=app.locator('#app-message a.notification-file-link');await expect(file).toHaveText(receipt.path);await expect(file).toHaveAttribute('href',receipt.download_url);
    let opening=null;await app.route('**/api/download-files/*/open',async route=>{opening={url:route.request().url(),body:route.request().postData()};await route.fulfill({contentType:'application/json',body:'{"opened":true}'});});
    await file.click();await expect.poll(()=>opening?.body).toBe('{}');assert.equal(new URL(opening.url).pathname,receipt.open_url);
    assert.equal(fs.existsSync(info.project),false,'Reference Excel keeps its existing no-Project exception');
    fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify({receipt,opening},null,2));await app.close();
  }finally{server.kill();await browser.close();}
  assert.deepEqual(errors,[]);console.log('Saved download links passed: actual native Pricing workbook and clickable notice, PDF new page, Excel action, multiple filenames, receipt collisions, language rerender, untrusted text, failure and dismissal.');
})().catch(async error=>{console.error(error);await activeBrowser?.close();process.exitCode=1;});
