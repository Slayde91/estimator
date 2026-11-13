// Settings layout and save notifications against an isolated disposable server.
const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', 'settings-rows-' + Date.now());
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs = '', stdout = '', browser, page;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve,reject) => {
  const timeout = setTimeout(() => reject(Error(logs || 'Fixture startup timed out')), 120000);
  server.once('error', error => { clearTimeout(timeout); reject(error); });
  server.once('exit', code => { clearTimeout(timeout); reject(Error('Fixture exited ' + code + ': ' + logs)); });
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(stdout.split('\n')[0])); } });
});
const errors = [], checks = [];
(async () => {
  const info = await ready; assert.notEqual(info.port,8765);
  const base = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1915,height:884}}); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.locator('#company-settings-save')).toBeEnabled();
  await expect(page.locator('#organization-timezone')).toBeEnabled();
  await expect(page.locator('#personal-details-save')).toBeEnabled();
  for (const form of ['company-settings-form','organization-timezone-form','personal-details-form','document-number-settings'])
    await expect(page.locator('#'+form).getByRole('button',{name:'Save',exact:true})).toHaveCount(1);
  await expect(page.locator('#document-number-settings').getByRole('button',{name:'Update existing records',exact:true})).toHaveCount(0);
  let migrations=0;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/document-numbering/migrate-orders')migrations++;});
  await page.getByLabel('Projects prefix',{exact:true}).fill('QA');
  await page.locator('#document-number-settings').getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('#project-details-settings-status')).toContainText('Saved');
  assert.equal((await (await page.request.get(base+'/api/numbering-settings')).json()).project.prefix,'QA');
  assert.equal(migrations,0,'Changing numbering preferences does not renumber existing files');
  await expect(page.locator('#language-help')).toHaveCount(0);
  await expect(page.locator('[aria-describedby~="language-help"]')).toHaveCount(0);
  assert.equal(await page.locator('#organization-timezone-form').evaluate(form => form.closest('section.card').querySelector('h2').textContent), 'Company Details');
  await expect(page.locator('#organization-timezone-status')).toBeHidden();
  await expect(page.locator('#view-settings').getByText('All team members use this time zone. Changing it recalculates overtime and penalties for recorded shifts.',{exact:true})).toHaveCount(0);
  const geometry = [];
  for (const width of [1915,1101,390]) {
    await page.setViewportSize({width,height:884});
    const measurements = await page.evaluate(() => {
      const box = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}; };
      const pair = selector => { const input=document.querySelector(selector), b=input.getBoundingClientRect(), label=input.closest('label').querySelector('span').getBoundingClientRect(); return {input:{left:b.left,top:b.top,bottom:b.bottom},label:{left:label.left,right:label.right,top:label.top,bottom:label.bottom}}; };
      return {width:innerWidth,documentWidth:document.documentElement.scrollWidth, language:box('#language-heading'),languageControl:box('#application-language-toggle'),appearance:box('#theme-toggle'),company:pair('#company-name'),personal:pair('#personal-name'),zone:pair('#organization-timezone'),logo:box('#company-logo'),preview:box('#company-logo-preview'),numberPrefix:box('#project-number-prefix')};
    });
    assert.ok(measurements.documentWidth <= width, JSON.stringify(measurements));
    assert.equal(measurements.languageControl.width, measurements.appearance.width);
    assert.equal(measurements.languageControl.height, measurements.appearance.height);
    const signature = await page.locator('#personal-signature-set').boundingBox(), savePersonal = await page.locator('#personal-details-save').boundingBox();
    assert.ok(savePersonal.y >= signature.y + signature.height, 'Personal Details ends with Save below the signature row');
    assert.ok(measurements.preview.top >= measurements.logo.bottom + 10, JSON.stringify(measurements));
    assert.ok(Math.abs(measurements.preview.left - measurements.logo.left) < 1);
    if (width > 600) {
      assert.ok(measurements.languageControl.left > measurements.language.right);
      assert.ok(Math.abs(measurements.languageControl.left - measurements.appearance.left) < 1);
      for (const pair of [measurements.company,measurements.personal,measurements.zone]) {
        assert.ok(pair.input.left > pair.label.right);
        assert.ok(Math.abs(pair.input.left - measurements.languageControl.left) < 1);
      }
    } else {
      for (const pair of [measurements.company,measurements.personal,measurements.zone]) assert.ok(pair.input.top >= pair.label.bottom);
      assert.ok(measurements.numberPrefix.width >= 90, 'Numbering controls remain usable inside their local scroll container');
    }
    geometry.push(measurements);
    await page.screenshot({path:path.join(output,`settings-${width}.png`),fullPage:true});
  }
  checks.push('Labels and controls align in shared columns; mobile stacks without overflow; logo preview is below upload');
  await page.setViewportSize({width:1101,height:884});
  await page.locator('#company-name').fill('Settings Row Company');
  await page.locator('#company-logo').setInputFiles(path.join(root,'static/icons/takeoff-set-default.png'));
  await page.locator('#company-settings-save').click();
  await expect(page.locator('#company-settings-status')).toHaveText('Saved');
  const company = await (await page.request.get(base+'/api/company-settings')).json();
  assert.equal(company.name,'Settings Row Company'); assert.ok(company.logo.startsWith('data:image/png;base64,'));
  await page.locator('#personal-name').fill('Settings Row Signer');
  await page.locator('#personal-details-save').click();
  await expect(page.locator('#personal-details-status')).toContainText('Personal details saved. They are copied to a certificate only when it is signed.');
  const personal = await (await page.request.get(base+'/api/certifications/defaults')).json();
  assert.equal(personal.fields.name,'Settings Row Signer');
  checks.push('Company and Personal Details retain existing independent save APIs');
  const zone = page.locator('#organization-timezone'), notice = page.locator('#organization-timezone-status'), save = page.locator('#organization-timezone-form button[type=submit]');
  const initialZone = await (await page.request.get(base+'/api/scheduler/organization')).json();
  await zone.selectOption('Asia/Kathmandu');
  await page.route('**/api/scheduler/organization', route => route.request().method()==='POST' ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure'})}) : route.continue());
  await save.click(); await expect(notice).toContainText('Synthetic save failure');
  await expect(notice).not.toContainText('All team members');
  assert.equal((await (await page.request.get(base+'/api/scheduler/organization')).json()).timezone,initialZone.timezone);
  await page.unroute('**/api/scheduler/organization');
  await save.click();
  await expect(notice).toContainText('Time zone saved. All team members use this time zone. Changing it recalculates overtime and penalties for recorded shifts.');
  await expect(notice).toHaveAttribute('data-notification','true');
  await expect(save).toBeDisabled();
  assert.equal((await (await page.request.get(base+'/api/scheduler/organization')).json()).timezone,'Asia/Kathmandu');
  await notice.getByRole('button',{name:'Close',exact:true}).click(); await expect(notice).toBeHidden();
  checks.push('Time-zone explanation appears only after confirmed save, is dismissible, and failed saves retain their draft');
  const currentZone = await (await page.request.get(base+'/api/scheduler/organization')).json();
  const changedZone = await page.request.post(base+'/api/scheduler/organization',{data:{version:currentZone.version,timezone:'UTC'}}); assert.equal(changedZone.status(),200);
  await zone.selectOption('Europe/London'); await save.click();
  await expect(notice).toContainText('Settings changed. Review the current time zone and try again.');
  await expect(notice).not.toContainText('All team members'); await expect(zone).toHaveValue('UTC');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({checks,geometry,errors},null,2));
  console.log('Settings rows acceptance passed: '+output);
})().catch(async error => {console.error(error);console.error(logs);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async () => {await browser?.close();server.kill();});
