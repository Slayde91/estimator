'use strict';
const assert = require('node:assert/strict');
const {expect} = require('@playwright/test');
const {chooseTakeoff} = require('./section_navigation.cjs');
const {contrast} = require('./physical_tools_helpers.cjs');

// The existing appearance journey owns this disposable server and its models.
// Seed through validated commands so real filter/selection states can be checked.
async function seedRegisterParity(page,fixture) {
  assert.notEqual(new URL(page.url()).port, '8765');
  await chooseTakeoff(page, 'steel');
  await page.locator('#takeoff-upload').setInputFiles(fixture.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1,{timeout:60000});
  await page.waitForFunction(() => {try{return window.CeasefireTakeoffs.projectSnapshot()?.render_checks?.some(check => check.page===1 && check.success);}catch{return false;}});
  await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId();
    const request = async (suffix, data) => {
      const reply = await fetch(`/api/takeoffs/sessions/${sid}${suffix}`, {method: data ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, ...(data ? {body:JSON.stringify(data)} : {})});
      const body = await reply.json(); if (!reply.ok) throw Error(JSON.stringify(body)); return body;
    };
    let current = (await request('')).snapshot;
    for (const label of ['REGISTER-PARITY-A','REGISTER-PARITY-B']) current = (await request('/commands', {op:'create_item', expected_revision:current.revision, request_id:crypto.randomUUID(), item:{mode:'steel',quantity:1,fields:{mark:label,level:label}}})).snapshot;
    const commands = ['REGISTER-PARITY-A','REGISTER-PARITY-B'].map(label => ({op:'create',kind:'defect',entity:{id:crypto.randomUUID(),fields:{label,location:label,frl:'-/120/120'},evidence:[],uncertainty:{state:'not_assessed',note:''}}}));
    const preview = await request('/physical/preview', {scope:'defect_reports',expected_revision:current.revision,commands});
    current = (await request('/physical/apply', {scope:'defect_reports',expected_revision:preview.revision,request_id:crypto.randomUUID(),preview_id:preview.preview_id})).snapshot;
    takeoffs.applyProject(await takeoffs.prepareProject(current,sid)); await takeoffs.open();
  });
}

async function settled(control) {
  await control.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {})));
  });
}
async function appearance(control) {
  await settled(control);
  return control.evaluate(el => {
    const css = getComputedStyle(el), box = el.getBoundingClientRect();
    const properties = ['backgroundColor','backgroundImage','color','borderTopWidth','borderTopStyle','borderTopColor','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','fontFamily','fontSize','fontWeight','lineHeight','boxShadow','outlineColor','outlineWidth','outlineStyle','outlineOffset','opacity','cursor'];
    const icon = el.querySelector('svg') || el.querySelector('img') || el.querySelector('.button-symbol');
    let glyph = null;
    if (icon) {
      const style = getComputedStyle(icon), r = icon.getBoundingClientRect();
      glyph = {kind:icon.tagName.toLowerCase(),width:r.width,height:r.height,color:style.color,filter:style.filter};
      if (icon.matches('svg')) {const path=getComputedStyle(icon.querySelector('path')||icon);Object.assign(glyph,{fill:path.fill,stroke:path.stroke,strokeWidth:path.strokeWidth,strokeLinecap:path.strokeLinecap,strokeLinejoin:path.strokeLinejoin});}
      else if (icon.matches('.button-symbol') && !icon.children.length) Object.assign(glyph,{text:icon.textContent,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight});
    }
    return {width:box.width,height:box.height,css:Object.fromEntries(properties.map(key => [key,css[key]])),glyph};
  });
}
async function states(page,control) {
  await control.click({trial:true});
  await page.mouse.move(0,0); await control.evaluate(el => el.blur());
  const result = {default:await appearance(control)};
  await control.hover(); result.hover=await appearance(control);
  await page.mouse.move(0,0); await control.focus(); await control.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(control).toBeFocused();
  assert.equal(await control.evaluate(el => el.matches(':focus-visible')),true);
  result.focus=await appearance(control); assert.notEqual(result.focus.css.outlineStyle,'none');
  await control.evaluate(el => el.blur());
  const disabled = await control.getAttribute('disabled');
  try {await control.evaluate(el => el.disabled=true);result.disabled=await appearance(control);}
  finally {await control.evaluate((el,value) => value === null ? el.removeAttribute('disabled') : el.setAttribute('disabled',value),disabled);}
  assert.equal(await control.getAttribute('disabled'),disabled);
  for(const state of ['default','hover','focus']) await assertReadableControlFor(result[state]);
  return result;
}
function assertReadableControlFor(value) {
  const stops=value.css.backgroundImage==='none'?[value.css.backgroundColor]:value.css.backgroundImage.match(/rgba?\([^)]*\)/g)||[];
  assert.ok(stops.length);for(const stop of stops)assert.ok(contrast(value.css.color,stop)>=4.5,JSON.stringify(value));
}
async function registerCase(page,physical) {
  await chooseTakeoff(page,physical?'Defect Reports':'steel');
  const register=page.locator(physical?'.takeoff-physical-register':'.takeoff-register:not(.takeoff-physical-register)');
  const rows=register.locator(physical?'tbody tr[data-physical-id]':'tbody tr[data-item-id]');
  await expect(rows).toHaveCount(2);
  const button=name=>register.getByRole('button',{name,exact:true});
  const result={buttons:{}};
  for(const [key,label] of Object.entries({selection:physical?'Select filtered records':'Select filtered items',undo:'Undo last edit',transfer:physical?'Transfer to Firestopping Schedule':'Preview transfer',update:'Update linked rows',unlink:physical?'Unlink from Firestopping Schedule':'Detach links'})) result.buttons[key]=await states(page,button(label));
  const select=button(physical?'Select filtered records':'Select filtered items');
  await select.click();await expect(select).toHaveAttribute('aria-pressed','true');await page.mouse.move(0,0);await select.evaluate(el=>el.blur());result.selected=await appearance(select);assertReadableControlFor(result.selected);
  await select.click();await expect(select).toHaveAttribute('aria-pressed','false');
  const search=register.getByRole('searchbox',{name:physical?'Filter physical hierarchy':'Filter register',exact:true});
  result.search=await states(page,search);await search.fill('REGISTER-PARITY-A');await expect(rows).toHaveCount(1);await search.fill('');await expect(rows).toHaveCount(2);
  const filter=()=>button('Filter Confirmation');result.filter=await states(page,filter());
  const open=async()=>{await filter().click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Filter Confirmation',exact:true})).toBeVisible();await expect(filter()).toHaveAttribute('aria-expanded','true');return dialog;};
  let dialog=await open();result.openFilter=await appearance(filter());result.dialog=await appearance(dialog);
  result.dialogSearch=await states(page,dialog.getByRole('searchbox',{name:'Search Confirmation values',exact:true}));result.dialogButtons={};
  for(const name of ['Apply filter','Reset filter','Cancel'])result.dialogButtons[name]=await states(page,dialog.getByRole('button',{name,exact:true}));
  const bounds=await dialog.boundingBox(),view=page.viewportSize();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=view.width+1&&bounds.y+bounds.height<=view.height+1,JSON.stringify({bounds,view}));
  await dialog.getByRole('checkbox',{name:'Select all values',exact:true}).uncheck();await dialog.getByRole('button',{name:'Apply filter',exact:true}).click();await dialog.waitFor({state:'detached'});await expect(rows).toHaveCount(0);await expect(filter()).toHaveAttribute('aria-pressed','true');await page.mouse.move(0,0);result.activeFilter=await appearance(filter());assertReadableControlFor(result.activeFilter);
  dialog=await open();await dialog.getByRole('button',{name:'Reset filter',exact:true}).click();await dialog.waitFor({state:'detached'});await expect(rows).toHaveCount(2);await expect(filter()).toHaveAttribute('aria-pressed','false');
  for(const control of await register.locator('.takeoff-register-controls button:visible').all()) {const box=await control.boundingBox();assert.ok(box.height>=38);}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Register controls do not introduce document overflow');
  return result;
}

async function assertRegisterControlParity(page) {
  const original=page.viewportSize(),evidence=[];
  try {for(const width of [1384,825,390]) {
    await page.setViewportSize({width,height:764});const steel=await registerCase(page,false),physical=await registerCase(page,true);
    // Content length can change the dialog's height; its control family must match.
    const dialogStyle=value=>({...value,width:undefined,height:undefined});
    assert.deepEqual(dialogStyle(physical.dialog),dialogStyle(steel.dialog),`Filter dialog paint/spacing at ${width}`);
    for(const key of ['buttons','selected','search','filter','openFilter','activeFilter','dialogSearch','dialogButtons'])assert.deepEqual(physical[key],steel[key],`Steel/Defect Reports ${key} at ${width}`);
    assert.equal(physical.buttons.selection.default.width,38);assert.equal(physical.buttons.selection.default.height,38);assert.equal(physical.filter.default.width,24);assert.equal(physical.filter.default.height,24);
    evidence.push({width,steel,physical});
  }} finally {await page.setViewportSize(original);}
  return evidence;
}
module.exports={seedRegisterParity,assertRegisterControlParity};
