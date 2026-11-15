const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');

// Exercise the real editor and image decoder with a draft at the pixel limit.
async function checkRegisterLimits(browser) {
  const page = await browser.newPage();
  try {
    await page.route('http://localhost/register-test', route=>route.fulfill({contentType:'text/html',
      body:'<section class="view"><div id="passive-register-root"></div></section>'}));
    await page.goto('http://localhost/register-test');
    await page.evaluate(() => {
      window.CeasefireI18n = {text(element, value) { element.textContent = value; }, translate(value) { return value; }, attr() {}};
      window.CeasefireProject = {changed() {}};
    });
    await page.route('**/api/libraries/technical?*', route => route.fulfill({json:{filters:[],items:[],total:0}}));
    for (const file of ['form-controls.js','libraries.js','library-detail-text.js','passive-register-library.js','passive-fire-register.js']) {
      await page.addScriptTag({path:path.resolve(__dirname,'../../static',file)});
    }
    await page.evaluate(options => {
      window.ClassifirePassiveRegister.setOptions(options);
      window.ClassifirePassiveRegister.open();
    }, require('../../data/passive-fire-register-options.json'));
    await page.getByLabel('Level/Location').fill('Register limits test');
    const smallImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2000;
      const jpeg = canvas.toDataURL('image/jpeg');
      const state = window.ClassifirePassiveRegister.capture().value;
      const entry = state.entries[0];
      entry.access = 'NA';
      // The existing 32 images exactly consume the 128M pixel budget.
      entry.side2.before = Array(16).fill(jpeg);
      entry.side2.after = Array(16).fill(jpeg);
      window.ClassifirePassiveRegister.applyProject(state);
      canvas.width = canvas.height = 10;
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const photo = {name:'extra.png', mimeType:'image/png', buffer:Buffer.from(smallImage, 'base64')};
    await page.getByLabel('Before Photo', {exact:true}).setInputFiles(photo);
    await expect(page.getByRole('status')).toHaveText('The register photo limit has been reached.');
    assert.equal(await page.evaluate(() => window.ClassifirePassiveRegister.capture().value.entries[0].side1.before.length), 0);
    await page.evaluate(() => {
      const state = window.ClassifirePassiveRegister.capture().value;
      state.entries[0].side2.before.pop();
      window.ClassifirePassiveRegister.applyProject(state);
    });
    await page.getByLabel('Before Photo', {exact:true}).setInputFiles(photo);
    await expect(page.getByRole('img', {name:'Before Photo 1'})).toBeVisible();

    // A removed reference remains visible and clearable on reopening. A missing
    // thumbnail must never prevent an otherwise valid reference being selected.
    await page.route('**/api/libraries/inspection-labels', route => route.fulfill({json:
      {'available-item':{category:'Electrical',services:'Cables',frl:'-/60/60'}}}));
    await page.route('**/api/libraries/technical/removed-item', route => route.fulfill({status:404,json:{error:'Library reference not found.'}}));
    await page.route('**/api/libraries/technical/available-item', route => route.fulfill({json:{id:'available-item',title:'Available system',thumbnail_url:'/api/libraries/images/missing/thumbnail'}}));
    await page.route('**/api/libraries/images/missing/thumbnail', route => route.fulfill({status:404,body:''}));
    const reopen = id => page.evaluate(key => {
      const state = window.ClassifirePassiveRegister.capture().value;
      state.entries[0].technical_item_id = key;
      delete state.entries[0].technical_filters; // Saved before the picker recorded all seven choices.
      window.ClassifirePassiveRegister.applyProject(state);
    },id);
    const picker = page.locator('.register-library-picker');
    await reopen('removed-item');
    await expect(picker.getByRole('checkbox', {name:'removed-item'})).toBeChecked();
    await expect(picker.getByText('Library reference not found.')).toBeVisible();
    await picker.getByRole('checkbox',{name:'removed-item'}).click();
    await expect(picker.locator('[data-technical-item-id]')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.ClassifirePassiveRegister.capture().value.entries[0].technical_item_id),'');
    await reopen('available-item');
    await expect(picker.getByRole('checkbox', {name:'Available system'})).toBeChecked();
    await expect(page.locator('.register-toolbar option:checked')).toHaveText('001: Register limits test-—-Electrical-Cables--/60/60');
    assert.equal(await page.evaluate(() => window.ClassifirePassiveRegister.hasProjectChanges()), false);
    await expect(picker.getByRole('img')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.ClassifirePassiveRegister.capture().value.entries[0].technical_item_id),'available-item');
  } finally {
    await page.close();
  }
}

module.exports = {checkRegisterLimits};
