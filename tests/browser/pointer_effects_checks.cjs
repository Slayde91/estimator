// Real input, cleanup and native-dialog checks share the isolated header fixture.
const {expect}=require('@playwright/test');
const assert=require('node:assert/strict'),path=require('node:path');
async function checkPointerEffects(page,output) {
  const home=page.getByRole('button',{name:'Home',exact:true});
  const cursor=locator=>locator.evaluate(el=>getComputedStyle(el).cursor);
  await home.hover();
  assert.match(await cursor(home),/laser-reticle\.svg.*16 16, pointer/);
  assert.match(await cursor(home.locator('svg,img').first()),/laser-reticle\.svg/,'Reticle also covers button icons');
  const asset=await page.request.get(new URL('/laser-reticle.svg',page.url()).href);
  assert.equal(asset.status(),200);assert.match(asset.headers()['content-type'],/svg/);

  await home.click();
  await expect(page.locator('.click-smoke-puff')).toHaveCount(4);
  const geometry=await page.locator('.click-smoke-layer').evaluate(el=>{
    const puffs=[...el.querySelectorAll('.click-smoke-puff')];
    const frames=puffs.map(puff=>{const animation=puff.getAnimations()[0];animation.pause();animation.currentTime=120;return animation.effect.getKeyframes();});
    const delta=frames.map(keys=>{const from=new DOMMatrix(keys[0].transform),to=new DOMMatrix(keys.at(-1).transform);return[to.e-from.e,to.f-from.f];});
    return{delta,hidden:el.getAttribute('aria-hidden'),inert:el.inert,pointer:getComputedStyle(el).pointerEvents,topLayer:el.matches(':popover-open')};
  });
  assert.deepEqual(geometry,{delta:[[0,-30],[0,30],[-30,0],[30,0]],hidden:'true',inert:true,pointer:'none',topLayer:true});
  await expect(home).toBeFocused();
  await page.screenshot({path:path.join(output,'click-smoke-four-directions.png')});
  await page.evaluate(()=>document.querySelectorAll('.click-smoke-puff').forEach(el=>el.getAnimations().forEach(a=>a.play())));
  await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  await home.press('Enter');
  await expect(page.locator('.click-smoke-layer')).toHaveCount(0);

  // Smoke also appears on plain content, stays bounded under rapid clicks,
  // and disappears immediately when the motion preference changes.
  const heading=page.locator('#view-home h1');
  await heading.click();await expect(page.locator('.click-smoke-puff')).toHaveCount(4);
  const point=await heading.boundingBox();
  for(let i=0;i<15;i++)await page.mouse.click(point.x+4,point.y+4);
  assert.ok(await page.locator('.click-smoke-puff').count()<=32);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  await home.click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  assert.match(await cursor(home),/laser-reticle\.svg/,'Static reticle remains available with reduced motion');
  await page.emulateMedia({reducedMotion:'no-preference'});

  await page.evaluate(()=>{window.CeasefireDialogs.confirm('Pointer effect check','Synthetic dialog; no saved state changes.','Continue');});
  const dialog=page.getByRole('dialog',{name:'Pointer effect check',exact:true});
  await expect(dialog).toBeVisible();
  const paragraph=dialog.locator('p');await paragraph.click();
  await expect(page.locator('.click-smoke-puff')).toHaveCount(4);
  assert.equal(await page.locator('.click-smoke-layer').evaluate(el=>el.matches(':popover-open')),true,'Smoke paints above the native modal');
  await expect(dialog).toBeVisible();
  assert.equal(await dialog.evaluate(el=>el===document.activeElement||el.contains(document.activeElement)),true,'Pointer effect leaves focus inside the modal');
  assert.match(await cursor(dialog.getByRole('button',{name:'Continue',exact:true})),/^pointer$/,'Dialog actions use the system link cursor');
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
  await expect(page.locator('.click-smoke-layer')).toHaveCount(0);

  // Drawing tools remove transient dialog nodes, sometimes during a burst.
  await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.id='qa-transient-dialog';
    const text=document.createElement('p');text.textContent='Transient dialog content';
    const close=document.createElement('button');close.textContent='Dismiss transient dialog';
    close.addEventListener('click',()=>dialog.remove());
    dialog.append(text,close);document.body.append(dialog);dialog.showModal();
  });
  await page.locator('#qa-transient-dialog p').click();
  await page.evaluate(()=>document.querySelectorAll('.click-smoke-puff').forEach(el=>el.getAnimations().forEach(a=>a.pause())));
  await page.getByRole('button',{name:'Dismiss transient dialog',exact:true}).click();
  await expect(page.locator('#qa-transient-dialog')).toHaveCount(0);
  assert.equal(await page.locator('.click-smoke-layer').evaluate(el=>el.parentElement===document.body),true,'Smoke survives removing a transient dialog');
  await page.evaluate(()=>document.querySelectorAll('.click-smoke-puff').forEach(el=>el.getAnimations().forEach(a=>a.play())));
  await expect(page.locator('.click-smoke-layer')).toHaveCount(0);

  await page.locator('#estimate-navigation-toggle').hover();
  await page.locator('#estimate-navigation-menu [data-estimator-kind="estimate"]').click();
  const tab=page.locator('#main-section-tabs [role="tab"]').first();await expect(tab).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/\bapp-busy\b/,{timeout:60000});
  await tab.hover();assert.match(await cursor(tab),/^pointer$/,'Ordinary tabs use the system link cursor');
  const input=page.locator('#client');
  assert.doesNotMatch(await cursor(input),/laser-reticle/,'Text fields keep their editing cursor');
  const originalDisabled=await tab.evaluate(el=>{const before=el.disabled;el.disabled=true;return before;});
  assert.match(await cursor(tab),/^not-allowed$/,'Disabled controls use the system unavailable cursor');
  await tab.evaluate((el,value)=>{el.disabled=value;},originalDisabled);
  await page.evaluate(()=>document.documentElement.classList.add('app-busy'));
  assert.match(await cursor(home),/^progress$/,'Busy state uses the system loading cursor');
  await page.evaluate(()=>document.documentElement.classList.remove('app-busy'));
  await home.click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
  return{reticle:true,icons:true,tabs:true,modal:true,transientDialog:true,cardinalSmoke:true,plainContent:true,cleanup:true,bounded:true,reducedMotion:true,keyboardFocus:true,editingCursor:true};
}
module.exports={checkPointerEffects};
