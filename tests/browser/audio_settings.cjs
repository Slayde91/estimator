'use strict';
// Settings integration with instrumented media. This verifies play/stop calls,
// not physical audibility or decoder behavior (covered by native media checks).
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','audio-settings-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'header_menu_sounds_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let text='',logs='',browser;server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exit '+code));});server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});});
(async()=>{
 const {port}=await ready;assert.notEqual(port,8765);
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1213,height:884}});
 await context.addInitScript(()=>{
  window.qaAudio=[];
  window.Audio=class extends EventTarget{
   constructor(){super();this.readyState=4;this.paused=true;this.currentTime=0;this.calls=0;window.qaAudio.push(this);}
   load(){}pause(){this.paused=true;}play(){this.paused=false;this.calls++;return Promise.resolve();}
  };
  Math.random=()=>.999;
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const base='http://127.0.0.1:'+port;await page.goto(base+'/');await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 await expect.poll(()=>page.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0))).toBeGreaterThan(0);
 const initial=await page.evaluate(()=>({details:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration()}));
 await page.getByRole('button',{name:'Settings',exact:true}).click();const audio=page.getByRole('checkbox',{name:'Enable audio',exact:true});await expect(audio).toBeChecked();
 await audio.uncheck();await expect(page.locator('#audio-status')).toHaveText('Audio disabled');
 assert.ok(await page.evaluate(()=>window.qaAudio.every(audio=>audio.paused&&audio.currentTime===0)),'Mute stops every active clip immediately');
 const mutedCalls=await page.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0));
 await page.getByRole('button',{name:'Home',exact:true}).hover();await page.getByRole('button',{name:'Home',exact:true}).click();
 await page.evaluate(()=>{const event=new MouseEvent('click',{bubbles:true,cancelable:true});event.preventDefault();document.querySelector('.app-header .brand').dispatchEvent(event);window.CeasefireHeaderTagline.next();});
 assert.equal(await page.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0)),mutedCalls,'Header, brand and tagline stay silent');
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(audio).not.toBeChecked();
 const second=await context.newPage();second.on('pageerror',error=>errors.push(error.message));await second.goto(base+'/');await second.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 assert.equal(await second.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0)),0,'The new window restores mute before playback initialization');
 await second.getByRole('button',{name:'Settings',exact:true}).click();const secondAudio=second.getByRole('checkbox',{name:'Enable audio',exact:true});await expect(secondAudio).not.toBeChecked();
 await secondAudio.focus();await secondAudio.press('Space');await expect(secondAudio).toBeChecked();await expect(audio).toBeChecked();
 const before=await second.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0));await second.getByRole('button',{name:'Home',exact:true}).click();
 assert.ok(await second.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0))>before,'A new interaction plays after re-enabling');
 await second.getByRole('button',{name:'Settings',exact:true}).click();await secondAudio.uncheck();await expect(audio).not.toBeChecked();
 await page.reload();await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);assert.equal(await page.evaluate(()=>window.qaAudio.reduce((count,audio)=>count+audio.calls,0)),0);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(audio).not.toBeChecked();
 assert.deepEqual(await page.evaluate(()=>({details:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration()})),initial,'Audio is presentation-only');
 await page.screenshot({path:path.join(output,'audio-disabled-settings.png'),fullPage:false});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,fixturePort:port,checks:['enabled default','immediate stop','all current sound gates','persisted reload','new-window pre-playback mute','cross-window updates','keyboard toggle','fresh interaction after enable','Project data unchanged'],errors},null,2));console.log('PASS audio Settings: '+output);
})().catch(error=>{console.error(error);console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
