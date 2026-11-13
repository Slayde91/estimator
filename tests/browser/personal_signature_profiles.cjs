const assert = require('node:assert/strict');
const {expect} = require('@playwright/test');
const {openProjectSection} = require('./project_actions.cjs');
const {openCertificateEditor} = require('./certification_generation.cjs');

module.exports = async function signatureProfiles(page, admin) {
  const base = new URL(page.url()).origin;
  const saved = () => page.evaluate(() => window.ClassifirePersonalSignature.saved());
  async function account(action, body, headers={}) {
    const response = await page.request.post(base + '/api/' + action, {data:body,headers});
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }
  async function setSignature(remember, diagonal) {
    await page.locator('#personal-signature-set').click();
    const pad = page.getByRole('dialog',{name:'Personal signature'});
    await pad.getByRole('checkbox',{name:'Remember this signature on this computer'}).setChecked(remember);
    const box = await pad.getByLabel('Signature drawing pad').boundingBox();
    await page.mouse.move(box.x+box.width*.15,box.y+box.height*.5); await page.mouse.down();
    await page.mouse.move(box.x+box.width*.4,box.y+box.height*diagonal,{steps:3});
    await page.mouse.move(box.x+box.width*.8,box.y+box.height*.55,{steps:3}); await page.mouse.up();
    await pad.getByRole('button',{name:'Insert signature'}).click();
    await expect(pad).toHaveCount(0);
    return saved();
  }
  await page.locator('nav [data-view="settings"]').click();
  assert.equal((await page.request.get(base+'/icons/signature.svg')).status(),200);
  const staffId=await page.evaluate(()=>window.ClassifireAccess.user.id);
  const temporary = await setSignature(false,.8);
  assert.ok(temporary.strokes.length);
  assert.equal(await page.evaluate(id=>localStorage.getItem('ceasefire.takeoff-signature.v1.'+id),staffId),null);
  const second={email:'second@example.test',password:'Isolated-alternate-signature'};
  const other=await account('scheduler/members/save',{...second,name:'Second tester',role:'worker',active:true,base_rate:'0'});
  await account('access/roles',{member_id:other.id,role:'editor',version:0},{'X-CRM-Member':staffId});
  const personal = await setSignature(true,.15);
  assert.notDeepEqual(personal,temporary);

  await openProjectSection(page,'swms');
  const swms = page.locator('#swms-root');
  await swms.getByRole('button',{name:'New SWMS',exact:true}).click();
  const manager = swms.getByRole('img',{name:'Project manager drawn signature'});
  const managerControls = swms.locator('.swms-signature:not(.swms-contact-signature)').first();
  await expect(manager).toHaveCount(0);
  await managerControls.getByRole('button',{name:'Draw signature',exact:true}).click();
  await expect(manager).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields.manager_signature),personal);
  await managerControls.getByRole('button',{name:'Replace signature',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
  await swms.getByRole('button',{name:'Save',exact:true}).last().click();
  await expect(swms.locator('.swms-message')).toContainText('Saved.');

  await openProjectSection(page,'certification');
  await openCertificateEditor(page);
  const preview = page.locator('#certification-signature-preview');
  await expect(preview).toBeHidden();
  await page.locator('#certification-signature-use').click();
  await expect(preview).toBeVisible();
  assert.equal(await preview.getAttribute('src'),await page.evaluate(value=>window.ClassifirePersonalSignature.png(value),personal));
  await page.locator('#certification-signature-use').click();
  const drawing = page.getByRole('dialog',{name:'Signatures',exact:true});
  await expect(drawing.getByLabel('Signature drawing pad')).toBeVisible();
  await account('access/login',second);
  await drawing.getByRole('button',{name:'Use saved signature'}).click();
  await expect(drawing.getByRole('status')).toContainText(/profile changed|Could not load/);
  await drawing.getByRole('button',{name:'Cancel'}).click();
  const otherPage=await page.context().newPage();
  try {
    await otherPage.goto(base);await otherPage.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    assert.equal(await otherPage.evaluate(()=>window.ClassifireAccess.user.id),other.id);
    assert.equal(await otherPage.evaluate(()=>window.ClassifirePersonalSignature.saved()),null);
  } finally { await otherPage.close(); }
  await account('access/login',admin);
  assert.deepEqual(await saved(),personal);
};
