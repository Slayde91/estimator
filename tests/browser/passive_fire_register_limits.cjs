const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');

// Exercise the real editor and image decoder with a draft at the pixel limit.
async function checkRegisterLimits(browser) {
  const page = await browser.newPage();
  try {
    await page.setContent('<section class="view"><div id="passive-register-root"></div></section>');
    await page.evaluate(() => {
      window.CeasefireI18n = {text(element, value) { element.textContent = value; }};
      window.CeasefireProject = {changed() {}};
    });
    await page.addScriptTag({path:path.resolve(__dirname, '../../static/passive-fire-register.js')});
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
  } finally {
    await page.close();
  }
}

module.exports = {checkRegisterLimits};
