// Deterministic GPS/permission/timer acceptance. Only disposable accounts and synthetic Sydney points.
const {chromium,expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..'), output = path.join(root,'.runtime/browser-qa',`scheduler-locations-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page; server.stderr.on('data',chunk=>logs+=chunk);
const ready = new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error(`Fixture exited ${code}`));});});
const errors=[],checks=[];
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1575,height:884}});
  const setup=await context.request.post(base+'/api/scheduler/setup',{data:{name:'Location QA Admin',email:'location-qa@example.test',password:'Disposable-location-password-2026'}});assert.equal(setup.status(),200);
  const state=await (await context.request.get(base+'/api/scheduler/state?start=2026-11-02&end=2026-11-09')).json();
  const points=[],requests=[],tiles=[];let sequence=0,mapOffline=false,locationGate=null;
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const tileImage=Buffer.from(await page.evaluate(()=>{const tile=document.createElement('canvas');tile.width=tile.height=256;const ctx=tile.getContext('2d');ctx.fillStyle='#edf1e5';ctx.fillRect(0,0,256,256);ctx.strokeStyle='#fff';ctx.lineWidth=16;ctx.beginPath();ctx.moveTo(0,80);ctx.lineTo(256,80);ctx.moveTo(120,0);ctx.lineTo(120,256);ctx.stroke();ctx.fillStyle='#465440';ctx.font='12px sans-serif';ctx.fillText('Synthetic map fixture',8,25);return tile.toDataURL('image/png').split(',')[1];}),'base64');
  await page.clock.install({time:new Date('2026-11-06T00:00:00Z')});
  await page.addInitScript(()=>{
    window.__gpsAcknowledgements=0;
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(args[1]?.method==='POST' && /\/api\/scheduler\/locations(?:\/enable)?$/.test(String(args[0]))) {
        const json=response.json.bind(response);
        response.json=async()=>{const result=await json();window.__gpsAcknowledgements++;return result;};
      }
      return response;
    };
    window.__gpsMode='denied';window.__gpsCalls=0;window.__gpsWatches=new Map();window.__gpsCleared=0;window.__gpsLatitude=-33.8688;let id=0;
    const fix=()=>({coords:{latitude:window.__gpsLatitude,longitude:151.2093,accuracy:10},timestamp:Date.now()-(window.__gpsMode==='stale'?180000:0)});
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition(ok,bad,options){window.__gpsCalls++;window.__gpsOptions=options;queueMicrotask(()=>window.__gpsMode==='denied'?bad({code:1}):ok(fix()));},
      watchPosition(ok,bad){window.__gpsWatches.set(++id,{ok,bad});return id;},
      clearWatch(key){window.__gpsCleared++;window.__gpsWatches.delete(key);}
    }});
    window.__gpsMovement=()=>{for(const watch of window.__gpsWatches.values())watch.ok(fix());};
    window.__gpsDenied=()=>{window.__gpsMode='denied';for(const watch of window.__gpsWatches.values())watch.bad({code:1});};
  });
  await page.route('**/api/scheduler/**',async route=>{
    const url=new URL(route.request().url()),action=url.pathname.replace('/api/scheduler/','');
    const payload=route.request().method()==='POST'?route.request().postDataJSON():null;
    if(action==='map-tile'){tiles.push(url.search);return mapOffline?route.fulfill({status:503,json:{error:'Offline map fixture'}}):route.fulfill({contentType:'image/png',body:tileImage});}
    requests.push({action,payload});
    let result;
    if(action==='bootstrap')result={setup_required:false,user:state.user};
    else if(action==='logout')result={signed_out:true};
    else if(action==='state')result=state;
    else if(action==='clock/in'){
      assert.equal(payload.location_consent,true);assert.ok(payload.location.captured_at);
      const start=payload.location.captured_at;
      const entry={id:`synthetic-clock-${++sequence}`,member_id:state.user.id,start,end:null,breaks:[],effective_breaks:[],version:1,project_name:'Synthetic Sydney site',notes:'',base_rate:'40',location_consent:true,location_summary:{count:1,first_at:start,last_at:start}};
      points.push({id:'point-1',entry_id:entry.id,...payload.location});state.active_entry=entry;state.entries=[entry];result=entry;
    } else if(action==='locations'||action==='locations/enable'){
      assert.equal(payload.entry_id,state.active_entry.id);points.push({id:`point-${points.length+1}`,...payload});
      state.active_entry.location_summary={count:points.length,first_at:points[0].captured_at,last_at:payload.captured_at};
      result={recorded:true,captured_at:payload.captured_at};
      const gate=locationGate;locationGate=null;if(gate)await gate;
    } else if(action==='clock/out'){
      state.entries[0].end=await page.evaluate(()=>new Date().toISOString());state.active_entry=null;result=state.entries[0];
    } else if(action==='locations' && !payload) result={};
    else throw Error(`Unexpected Scheduler action ${action}`);
    await route.fulfill({json:JSON.parse(JSON.stringify(result))});
  });
  // GET history has its own response; route registration order puts it before the general handler.
  await page.route('**/api/scheduler/locations?entry_id=*',async route=>{
    const entry=state.entries[0],last=points.at(-1).captured_at;
    await route.fulfill({json:{entry,locations:points,coverage:{gaps:entry.end&&Date.parse(entry.end)-Date.parse(last)>35*60000?[{start:last,end:entry.end,minutes:40}]:[]}}});
  });
  await page.goto(base+'/');await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await page.locator('#scheduler-navigation').click();
  await page.getByRole('button',{name:'Clock in',exact:true}).click();let modal=page.locator('dialog[open]');
  await modal.getByRole('button',{name:'Clock in',exact:true}).click();await expect(modal).toContainText('Location access is blocked');
  assert.equal(requests.filter(row=>row.action==='clock/in').length,0);
  await page.evaluate(()=>window.__gpsMode='stale');await modal.getByRole('button',{name:'Clock in',exact:true}).click();await expect(modal).toContainText('old or invalid location');
  assert.equal(requests.filter(row=>row.action==='clock/in').length,0);
  await page.evaluate(()=>window.__gpsMode='granted');await modal.getByRole('button',{name:'Clock in',exact:true}).click();await expect(modal).toHaveCount(0);
  await expect(page.locator('.scheduler-clock')).toContainText('Location recording is on');assert.equal(points.length,1);
  assert.deepEqual(await page.evaluate(()=>window.__gpsOptions),{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  checks.push('denied/stale fixes block clock-in; fresh fix is included in atomic clock-in request');
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.evaluate(()=>sessionStorage.clear());await page.reload();await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await expect.poll(()=>page.evaluate(()=>window.__gpsWatches.size)).toBe(1);
  await expect(page.locator('.scheduler-tracking-banner')).toBeVisible();
  await page.evaluate(()=>window.__gpsMode='granted');
  const before=await page.evaluate(()=>window.__gpsCalls);
  await page.clock.fastForward(29*60000);assert.equal(await page.evaluate(()=>window.__gpsCalls),before);
  await page.clock.fastForward(60000);await expect.poll(()=>points.length).toBe(2);
  await expect.poll(()=>page.evaluate(()=>window.__gpsAcknowledgements)).toBe(1);
  checks.push('reopening on Home restores tracking without sessionStorage; stationary position gets fresh 30-minute heartbeat');
  // Persist a movement, revoke permission, then deliver its older success response.
  // The acknowledgement must not erase the newer permission failure.
  let releaseLocation;locationGate=new Promise(resolve=>releaseLocation=resolve);
  await page.clock.fastForward(61000);await page.evaluate(()=>{window.__gpsLatitude=-33.8708;window.__gpsMovement();});await expect.poll(()=>points.length).toBe(3);
  await page.evaluate(()=>window.__gpsDenied());await expect(page.locator('.scheduler-tracking-banner')).toContainText('Location access is blocked');
  releaseLocation();await expect.poll(()=>page.evaluate(()=>window.__gpsAcknowledgements)).toBe(2);
  await expect(page.locator('.scheduler-tracking-banner')).toContainText('Location access is blocked');
  checks.push('a delayed successful location acknowledgement cannot erase a newer permission-denied warning');
  await page.evaluate(()=>{window.__gpsMode='granted';window.dispatchEvent(new Event('online'));});
  await expect.poll(()=>page.evaluate(()=>window.__gpsAcknowledgements)).toBe(3);
  await expect(page.locator('.scheduler-tracking-banner')).toContainText('Location recording is on');assert.equal(points.length,4);
  checks.push('a new successful location request after permission is restored clears the warning');
  await page.evaluate(()=>window.__gpsDenied());await expect(page.locator('.scheduler-tracking-banner')).toContainText('Location access is blocked');
  await page.clock.fastForward(40*60000);assert.equal(points.length,4);
  await page.locator('#scheduler-navigation').click();
  const clockOut=page.getByRole('button',{name:'Clock out',exact:true});await expect(clockOut).toHaveCSS('background-color','rgb(23, 103, 178)');await clockOut.click();
  await expect(page.getByRole('button',{name:'Clock in',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.__gpsWatches.size),0);const stopped=await page.evaluate(()=>window.__gpsCalls);await page.clock.fastForward(60*60000);assert.equal(await page.evaluate(()=>window.__gpsCalls),stopped);
  checks.push('movement stored; revoked permission exposes missing coverage; clock-out remains possible and stops all tracking');
  await page.locator('.scheduler-tabs').getByRole('button',{name:'Time entries',exact:true}).click();await page.getByRole('button',{name:/Locations for Location QA Admin/}).first().click();
  await expect(page.locator('.scheduler-location-list li')).toHaveCount(4);await expect(page.locator('.scheduler-location-gaps')).toContainText('Missing location intervals');
  await expect(page.locator('.scheduler-map-status')).toContainText('Drag to pan');
  await page.locator('.scheduler-timeline-point').nth(3).click();await expect(page.locator('.scheduler-timeline-point').nth(3)).toHaveAttribute('aria-current','true');
  await page.getByRole('button',{name:'Play route',exact:true}).click();await page.clock.fastForward(4000);await expect(page.getByRole('button',{name:'Play route',exact:true})).toBeVisible();
  assert.ok(tiles.length>0 && tiles.length<=16);assert.ok(tiles.every(query=>/^\?z=\d+&x=\d+&y=\d+$/.test(query)));
  await page.screenshot({path:path.join(output,'location-popup-desktop.png'),fullPage:true});
  mapOffline=true;await page.getByRole('button',{name:'Zoom out map',exact:true}).click();await expect(page.locator('.scheduler-map-status')).toContainText('Street map unavailable');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:path.join(output,'location-popup-mobile.png'),fullPage:true});
  checks.push('map popup timeline/playback/coverage gaps works offline; only visible tile coordinates requested; responsive layout');
  // A shared-cookie account change must immediately remove private maps, including in-flight responses.
  await page.setViewportSize({width:1575,height:884});
  const adminState=JSON.parse(JSON.stringify(state));state.user={...state.user,id:'other-worker',role:'worker',name:'Other worker'};state.entries=[];
  await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});
  await expect(page.locator('.scheduler-locations')).toHaveCount(0);await expect(page.locator('.scheduler-account')).toContainText('Other worker');
  Object.assign(state,adminState);await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
  await page.locator('.scheduler-tabs').getByRole('button',{name:'Time entries',exact:true}).click();
  let releaseHistory;const held=new Promise(resolve=>releaseHistory=resolve);let historyStarted=false;
  await page.route('**/api/scheduler/locations?entry_id=*',async route=>{historyStarted=true;await held;await route.fulfill({json:{locations:points,coverage:{gaps:[]},entry:adminState.entries[0]}});});
  await page.getByRole('button',{name:/Locations for Location QA Admin/}).first().click();await expect.poll(()=>historyStarted).toBe(true);
  state.user={...state.user,id:'other-worker',role:'worker',name:'Other worker'};state.entries=[];
  await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});await expect(page.locator('.scheduler-account')).toContainText('Other worker');
  releaseHistory();await page.waitForTimeout(50);await expect(page.locator('.scheduler-locations')).toHaveCount(0);
  checks.push('account changes close private maps and discard delayed former-account history responses');
  for(const status of [200,401]) {
    let releaseState,started=false;const gate=new Promise(resolve=>releaseState=resolve);const oldState=JSON.parse(JSON.stringify(state));
    const delay=async route=>{if(started)return route.fallback();started=true;await gate;await route.fulfill({status,json:status===200?oldState:{error:'Expired former session'}});};
    await page.route('**/api/scheduler/state?*',delay);await page.evaluate(()=>{void window.CeasefireScheduler.activate();});await expect.poll(()=>started).toBe(true);
    Object.assign(state,adminState);await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
    releaseState();await page.waitForTimeout(50);await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');await expect(page.locator('.scheduler-auth')).toHaveCount(0);
    await page.unroute('**/api/scheduler/state?*',delay);
    state.user={...state.user,id:'other-worker',role:'worker',name:'Other worker'};state.entries=[];
    await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});await expect(page.locator('.scheduler-account')).toContainText('Other worker');
  }
  checks.push('delayed former-account state success and 401 cannot overwrite a newer signed-in account');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.locator('.scheduler-auth')).toBeVisible();
  let releaseBootstrap,bootstrapStarted=false;const bootstrapGate=new Promise(resolve=>releaseBootstrap=resolve);
  await page.route('**/api/scheduler/bootstrap',async route=>{bootstrapStarted=true;await bootstrapGate;await route.fulfill({json:{setup_required:false,user:null}});});
  await page.evaluate(()=>{void window.CeasefireScheduler.activate();});await expect.poll(()=>bootstrapStarted).toBe(true);
  Object.assign(state,adminState);await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
  releaseBootstrap();await page.waitForTimeout(50);await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');await expect(page.locator('.scheduler-auth')).toHaveCount(0);
  checks.push('a delayed signed-out bootstrap cannot replace a newer signed-in account with the login form');
  // Exercise the actual authenticated backend as well as the deterministic
  // history mocks above. Browser API requests share this context's cookies.
  // A pending action must retain its original identity across GPS and HTTP waits.
  await page.close();
  // Use a separate context so the deterministic location clock above cannot
  // affect the real backend's GPS freshness validation.
  const raceContext=await browser.newContext({storageState:await context.storageState(),viewport:{width:1575,height:884}});
  const realPost=async(action,data)=>{
    const response=await raceContext.request.post(base+'/api/scheduler/'+action,{data});
    assert.equal(response.status(),200,await response.text());return response.json();
  };
  const worker=await realPost('members/save',{name:'Account race worker',email:'account-race@example.test',password:'Disposable-account-race-2026',base_rate:'40.00'});
  const realState=async()=>{
    const response=await raceContext.request.get(base+'/api/scheduler/state?start=2026-11-02&end=2026-11-09');
    assert.equal(response.status(),200,await response.text());return response.json();
  };
  page=await raceContext.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.__raceHoldGps=true;window.__racePendingGps=[];window.__raceWatches=new Set();let id=0;
    window.__raceClockPosts=0;window.__raceClockBodies=0;
    const fetch=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const clock=args[1]?.method==='POST'&&String(args[0]).endsWith('/api/scheduler/clock/in');
      if(clock)window.__raceClockPosts++;
      const response=await fetch(...args);
      if(clock){const json=response.json.bind(response);response.json=async()=>{const value=await json();window.__raceClockBodies++;return value;};}
      return response;
    };
    const fix=()=>({coords:{latitude:-33.8688,longitude:151.2093,accuracy:10},timestamp:Date.now()});
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition(ok){if(window.__raceHoldGps)window.__racePendingGps.push(()=>ok(fix()));else queueMicrotask(()=>ok(fix()));},
      watchPosition(){window.__raceWatches.add(++id);return id;},
      clearWatch(key){window.__raceWatches.delete(key);}
    }});
    window.__raceReleaseGps=async()=>{for(const release of window.__racePendingGps.splice(0))release();await new Promise(resolve=>requestAnimationFrame(()=>queueMicrotask(resolve)));};
  });
  const realClockRequests=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/scheduler/clock/in')realClockRequests.push(request);});
  await page.goto(base+'/');await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await page.locator('#scheduler-navigation').click();
  await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
  const announceAccount=async()=>{
    await page.evaluate(()=>{const channel=new BroadcastChannel('classifire-scheduler-account');channel.postMessage('changed');channel.close();});
  };
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await page.locator('dialog[open]').getByLabel('Notes',{exact:true}).fill('Former account intent');
  await page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__racePendingGps.length)).toBe(1);
  await realPost('login',{email:'account-race@example.test',password:'Disposable-account-race-2026'});await announceAccount();
  await expect(page.locator('.scheduler-account')).toContainText('Account race worker');
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await page.locator('dialog[open]').getByLabel('Notes',{exact:true}).fill('New worker draft');
  await page.evaluate(()=>window.__raceReleaseGps());
  assert.equal(await page.evaluate(()=>window.__raceClockPosts),0,'The old GPS callback must not even initiate a clock-in fetch after identity changes');
  assert.equal(realClockRequests.length,0,'The former account GPS callback must not submit a clock-in for the newly signed-in member');
  assert.equal((await realState()).active_entry,null);
  await expect(page.locator('dialog[open]').getByLabel('Notes',{exact:true})).toHaveValue('New worker draft');
  await expect(page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.__raceWatches.size),0);
  await page.locator('dialog[open]').getByRole('button',{name:'Cancel',exact:true}).click();
  checks.push('real backend: an account switch cancels pending GPS clock-in intent without closing the new member dialog');

  let releaseClockResponse,acceptedClock=null;
  const clockResponseGate=new Promise(resolve=>releaseClockResponse=resolve);
  await page.route('**/api/scheduler/clock/in',async route=>{
    if(acceptedClock)return route.fallback();
    const response=await route.fetch();acceptedClock={...await response.json(),response_status:response.status()};
    await clockResponseGate;await route.fulfill({response});
  });
  await page.evaluate(()=>window.__raceHoldGps=false);
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true}).click();
  await expect.poll(()=>acceptedClock!==null).toBe(true);
  assert.equal(acceptedClock.response_status,200,acceptedClock.error);assert.equal(acceptedClock.member_id,worker.id);
  assert.equal((await realState()).active_entry.member_id,worker.id);
  await realPost('login',{email:'location-qa@example.test',password:'Disposable-location-password-2026'});await announceAccount();
  await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await page.locator('dialog[open]').getByLabel('Notes',{exact:true}).fill('Current administrator draft');
  await page.evaluate(()=>window.__raceHoldGps=true);
  await page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__racePendingGps.length)).toBe(1);
  const oldClockResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/scheduler/clock/in');
  releaseClockResponse();await (await oldClockResponse).finished();
  await expect.poll(()=>page.evaluate(()=>window.__raceClockBodies)).toBe(1);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>queueMicrotask(resolve))));
  await expect(page.locator('.scheduler-account')).toContainText('Location QA Admin');
  await expect(page.locator('dialog[open]').getByLabel('Notes',{exact:true})).toHaveValue('Current administrator draft');
  await expect(page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(page.locator('dialog[open]')).toHaveCount(1);
  assert.equal((await realState()).active_entry,null);
  assert.equal(await page.evaluate(()=>window.__raceWatches.size),0,'The former account clock response must not start tracking for the current account');
  assert.equal(realClockRequests.length,1);assert.equal(realClockRequests[0].headers()['x-scheduler-member'],worker.id);
  await page.evaluate(()=>{window.__raceHoldGps=false;return window.__raceReleaseGps();});
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const currentEntry=(await realState()).active_entry;assert.equal(currentEntry.member_id,adminState.user.id);assert.equal(currentEntry.notes,'Current administrator draft');
  assert.equal(realClockRequests.length,2);assert.equal(realClockRequests[1].headers()['x-scheduler-member'],adminState.user.id);
  checks.push('real backend: a former member clock-in response cannot start current-member tracking, close their modal or clear a new in-flight action; the current intent still completes');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS deterministic Scheduler locations. '+output);
})().catch(async error=>{console.error(error);console.error(errors);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
