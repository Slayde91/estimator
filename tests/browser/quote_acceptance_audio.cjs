const assert = require('node:assert/strict');
const {expect} = require('@playwright/test');

async function observeQuoteSound(page) {
  await page.addInitScript(() => {
    window.quoteSound = {attempts:0, playing:0};
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (new URL(this.src, location.href).pathname === '/sounds/money.mp3') {
        window.quoteSound.attempts++;
        this.addEventListener('playing', event => { if (event.isTrusted) window.quoteSound.playing++; }, {once:true});
      }
      return play.apply(this,args);
    };
  });
}

async function checkQuoteSound(page, expected) {
  await expect.poll(() => page.evaluate(() => window.quoteSound)).toEqual({attempts:expected,playing:expected});
}

async function exerciseQuoteSound(page, quote, {initialStatus, saveEndpoint, statusEndpoint, title}) {
  const status = quote.getByLabel('Status',{exact:true}), save = quote.getByRole('button',{name:'Save',exact:true});
  const card = quote.locator('.commercial-card').first();
  async function saveStatus(value) {
    await status.selectOption(value);
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === saveEndpoint);
    await save.click(); assert.equal((await response).status(), 200);
    await expect(save).toBeEnabled();
    await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  }
  async function moveTo(value, drag = false) {
    const lane = quote.locator(`.commercial-column[data-status="${value}"]`);
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === statusEndpoint);
    if (drag) await card.dragTo(lane);
    else { await card.locator('summary').click(); await card.getByLabel('Move to').selectOption(value); }
    assert.equal((await response).status(), 200);
    await expect(card).toBeVisible();
    await expect(card.locator('..')).toHaveAttribute('data-status',value);
  }
  await expect(status).toHaveValue(initialStatus);
  await checkQuoteSound(page,0);
  const reject = route => route.fulfill({status:503,json:{error:'Test write failure'}});
  await page.route('**'+saveEndpoint,reject,{times:1});
  await status.selectOption('Accepted'); await checkQuoteSound(page,0);
  await save.click(); await expect(quote.locator('.commercial-message')).toContainText('Test write failure');
  await checkQuoteSound(page,0);
  await saveStatus('Accepted'); await checkQuoteSound(page,1);
  await saveStatus('Accepted'); await checkQuoteSound(page,1);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  if (title) await quote.getByLabel('Search documents',{exact:true}).fill(title);
  await card.locator('.project-title-button').click(); await expect(status).toHaveValue('Accepted'); await checkQuoteSound(page,1);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  if (title) await quote.getByLabel('Search documents',{exact:true}).fill(title);
  await moveTo('Presented'); await checkQuoteSound(page,1);
  await page.route('**'+statusEndpoint,reject,{times:1});
  await card.locator('summary').click(); await card.getByLabel('Move to').selectOption('Accepted');
  await expect(quote.locator('.commercial-message')).toContainText('Test write failure'); await checkQuoteSound(page,1);
  await moveTo('Accepted',true); await checkQuoteSound(page,2);
  await page.evaluate(() => window.CeasefireAudioSettings.setEnabled(false));
  await moveTo('Presented'); await moveTo('Accepted'); await checkQuoteSound(page,2);
  await page.evaluate(() => window.CeasefireAudioSettings.setEnabled(true));
  await checkQuoteSound(page,2); await moveTo('Presented'); await moveTo('Accepted'); await checkQuoteSound(page,3);
  await moveTo(initialStatus); await card.locator('.project-title-button').click(); await expect(status).toHaveValue(initialStatus);
}

module.exports = {observeQuoteSound, checkQuoteSound, exerciseQuoteSound};
