const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createNewProject, openProjectSection} = require('./project_actions.cjs');

const root = path.resolve(__dirname,'../..');
const output = path.join(root,'.runtime/browser-qa','passive-fire-register-' + Date.now());
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',
  [path.join(__dirname,'project_documentation_fixture.py'),'--directory',output,'--technical-fixture'], {cwd:root,windowsHide:true});
let browser, page, log = '';
server.stderr.on('data',data => log += data);
const ready = new Promise((resolve,reject) => {
  let line = '';
  const timer = setTimeout(() => reject(Error('Fixture startup timed out')),120000);
  server.on('error',reject);
  server.on('exit',() => {clearTimeout(timer);reject(Error(log));});
  server.stdout.on('data',data => {
    line += data;
    if (line.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(line.split('\n')[0]));}
  });
});
const idle = () => page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready && !window.CeasefireDesktop.status().busy);
async function register() {
  await openProjectSection(page,'documentation');
  const button = page.locator('button[data-document-kind="passive_fire_register.pdf"]');
  await button.waitFor({state:'attached'});
  if (!await button.isVisible()) await page.locator('#documentation-pdf-rows').getByRole('button',{name:'Schedules',exact:true}).click();
  await expect(button).toHaveAccessibleName('Download Passive Fire Inspections');
  await expect(page.locator('tr[data-document-kind="passive_fire_register.pdf"] #cover-sheet-passive_fire_register')).toHaveCount(1);
  assert.equal(await button.locator('xpath=ancestor::tr/preceding-sibling::tr[1]').getAttribute('data-document-kind'),'firestopping.schedule.pdf');
  await button.click();
  await expect(page.locator('#view-passive-fire-register')).toBeVisible();
  await idle();
}
async function downloadRegister(expectFile) {
  await openProjectSection(page,'documentation');
  const row = page.locator('tr[data-document-kind="passive_fire_registers.pdf"]');
  await row.waitFor({state:'attached'});
  if (!await row.isVisible()) await page.locator('#documentation-pdf-rows').getByRole('button',{name:'Schedules',exact:true}).click();
  assert.equal(await row.locator('xpath=preceding-sibling::tr[1]').getAttribute('data-document-kind'),'passive_fire_register.pdf');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/passive-fire-registers.pdf');
  await row.getByRole('button',{name:'Download Passive Fire Register'}).click();
  const result = await response;
  if (expectFile) {
    assert.equal(result.status(),200,await result.text());
    const receipt = await result.json();
    assert.equal(receipt.documentation.item.kind,'passive_fire_registers.pdf');
    assert.equal(receipt.documentation.item.filename,'PASSIVE_FIRE_REGISTER-1.pdf');
    assert.equal(path.basename(receipt.path),'PASSIVE_FIRE_REGISTER-1.pdf');
    const saved = fs.readFileSync(receipt.path);
    const revision = await page.request.get(new URL(receipt.documentation.item.url,page.url()).href);
    assert.deepEqual(await revision.body(),saved);
    assert.ok(revision.headers()['content-disposition'].includes('filename="PASSIVE_FIRE_REGISTER-1.pdf"'));
    const plan = await page.evaluate(async url => {
      const lib = await import('/vendor/pdfjs/build/pdf.mjs');
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
      const loading = lib.getDocument({url});
      try {
        const pdf = await loading.promise;
        const last = await pdf.getPage(pdf.numPages);
        const {items} = await last.getTextContent();
        const {width,height} = last.getViewport({scale:1});
        return {landscape:width > height, text:items.map(item => item.str).join(' ')};
      } finally { await loading.destroy(); }
    }, receipt.documentation.item.url);
    assert.ok(plan.landscape);
    assert.match(plan.text,/Rotated crop with UserUnit 2/);
    assert.match(plan.text,/\b001\b/);
  } else {
    assert.equal(result.status(),400);
    await expect(page.locator('#documentation-status')).toContainText('There are no completed passive fire inspections.');
  }
  await idle();
}
async function run() {
  const info = await ready;
  assert.notEqual(info.port,8765);
  browser = await chromium.launch({headless:true});
  await require('./passive_fire_register_limits.cjs').checkRegisterLimits(browser);
  page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.setDefaultTimeout(30000);
  await page.goto('http://127.0.0.1:' + info.port);
  await idle();
  await createNewProject(page,{client:'Synthetic fire register'});
  await register();
  const form = page.locator('#passive-register-root');
  const comments = form.getByRole('textbox',{name:'Comments',exact:true});
  const commentText = 'Seal checked at the marked location.\nRecord site condition before signing.';
  const signerName = form.getByRole('textbox',{name:'Name',exact:true});
  const signingDate = form.getByRole('textbox',{name:'Date',exact:true});
  const setSignerName = name => page.evaluate(async name => {
    const url = '/api/certifications/defaults';
    const settings = await (await fetch(url)).json();
    const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({fields:{...settings.fields,name},expected_version:settings.version})});
    if (!response.ok) throw Error('Could not set the fixture signer name.');
  }, name);
  await expect(signerName).toHaveValue('');
  await expect(signingDate).toHaveValue('');
  await expect(signerName).toHaveJSProperty('readOnly',true);
  await expect(signingDate).toHaveJSProperty('readOnly',true);
  await expect(comments).toHaveValue('');
  await expect(comments).toBeEditable();
  assert.equal(await comments.evaluate(input => input.closest('section').nextElementSibling.querySelector('h2').textContent), 'Signature');
  await comments.fill(commentText);
  await form.getByLabel('Level/Location').fill('North wall, Level 2');
  const toolbar = form.locator('.register-toolbar');
  const footer = form.locator('.register-footer-actions:last-child');
  for (const actions of [toolbar, footer]) {
    assert.deepEqual(await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
      ['Back','Add entry','Remove entry','Download PDF']);
    await expect(actions.getByRole('button',{name:'Add entry'})).toHaveClass(/add-icon-action/);
    await expect(actions.getByRole('button',{name:'Remove entry'}).locator('.trash-artwork')).toHaveCount(1);
    await expect(actions.getByRole('button',{name:'Download PDF'}).locator('.download-format')).toHaveText('PDF');
  }
  for (const width of [1915, 1160, 390]) {
    await page.setViewportSize({width, height:884});
    for (const actions of [toolbar, footer]) {
      const buttons = await actions.locator('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
      assert.ok(buttons.every(box => box.width === 42 && box.height === 42 && box.y === buttons[0].y));
      const icon = await actions.locator('.download-format-icon').boundingBox(), pdf = buttons[3];
      assert.ok(icon.x > pdf.x && icon.x + icon.width < pdf.right && icon.y > pdf.top && icon.y + icon.height < pdf.bottom);
      if (actions === footer) assert.equal(buttons[0].left, (await footer.boundingBox()).x);
    }
  }
  await page.setViewportSize({width:1280,height:900});
  await footer.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.locator('#view-documentation')).toBeVisible();
  await register();
  await expect(form.getByLabel('Level/Location')).toHaveValue('North wall, Level 2');
  await expect(comments).toHaveValue(commentText);
  const picker = form.locator('.register-library-picker');
  const library = await page.request.get(new URL('/api/libraries/technical?limit=1', page.url()).href);
  const {filters} = await library.json();
  const labels = await page.request.post(new URL('/api/libraries/inspection-labels', page.url()).href,
    {data:{ids:['report-a-v1','missing-item']}});
  assert.equal(labels.status(), 200);
  assert.deepEqual(await labels.json(), {'report-a-v1':{category:'Plumbing & Hydraulic', substrate:'Concrete/masonry wall', services:'Copper pipe'}});
  await expect(picker.locator('select:required')).toHaveCount(7);
  await expect(picker.locator('[data-library-filter="report"]')).toHaveCount(0);
  for (const filter of filters.filter(f => f.key !== 'report')) {
    const actual = await picker.locator('[data-library-filter="' + filter.key + '"] option').evaluateAll(options => options.map(o => o.value));
    const manual = filter.key === 'manufacturer' ? ['__enter_manufacturer__'] : [];
    assert.deepEqual(actual, ['', ...filter.options.map(o => o.value), ...manual]);
  }
  const manufacturer = picker.locator('[data-library-filter="manufacturer"]');
  await manufacturer.selectOption({label:'Enter custom manufacturer'});
  const custom = picker.getByLabel('Custom entry', {exact:true});
  await expect(custom).toBeChecked();
  await picker.getByLabel('Manufacturer name').fill('Independent works');
  for (const label of ['Seal Type', 'Installation Type', 'Service Type', 'Copper pipe(s)']) {
    await expect(picker.getByText(label,{exact:true})).toHaveCount(0);
  }
  await picker.getByLabel('Cast-In Collar',{exact:true}).check();
  await picker.getByLabel('Report/Assessment').fill('MAN-590');
  await expect(picker.locator('table')).toHaveCount(0);
  const savedManual = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save');
  await page.locator('#save-current-project').click();
  assert.equal((await savedManual).status(),200);
  await idle();
  const manualEntry = JSON.parse(fs.readFileSync(info.project)).passive_fire_register.entries[0];
  assert.equal(manualEntry.custom_entry, true);
  assert.equal(manualEntry.technical_filters.manufacturer, 'Independent works');
  assert.equal(manualEntry.seal_type, '');
  assert.equal(manualEntry.installation_type, '');
  assert.deepEqual(manualEntry.service_types, []);
  assert.deepEqual(manualEntry.products, ['Cast-In Collar']);
  assert.equal(manualEntry.report, 'MAN-590');
  await page.evaluate(value => window.ClassifirePassiveRegister.applyProject(value),
    JSON.parse(fs.readFileSync(info.project)).passive_fire_register);
  await expect(picker.getByLabel('Manufacturer name')).toHaveValue('Independent works');
  await expect(picker.getByLabel('Report/Assessment')).toHaveValue('MAN-590');
  await custom.uncheck();
  await expect(picker.getByLabel('Report/Assessment')).toHaveCount(0);
  await expect(manufacturer).toHaveValue('');
  const chosen = picker.locator('[data-technical-item-id="report-a-v1"]');
  const choices = {substrate:'Concrete/masonry wall', orientation:'Vertical', manufacturer:'Synthetic manufacturer',
    type:'Core hole', category:'Plumbing & Hydraulic', services:'Copper Pipes', frl:'-/90/90'};
  for (const [key, value] of Object.entries(choices)) {
    await picker.locator('[data-library-filter="' + key + '"]').selectOption(value);
    if (key !== 'frl') await expect(chosen).toBeDisabled();
  }
  await chosen.check();
  await expect(picker.getByRole('img')).toHaveJSProperty('naturalWidth', 240);
  await chosen.uncheck();
  await expect(picker.locator('select:required:visible')).toHaveCount(7);
  await chosen.check();
  await expect(form.getByLabel('ID Number')).toHaveValue('001');
  await expect(form.getByLabel('ID Number')).toHaveJSProperty('readOnly', true);
  const savedDraft = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save');
  await page.locator('#save-current-project').click();
  assert.equal((await savedDraft).status(),200);
  await idle();
  const entry = JSON.parse(fs.readFileSync(info.project)).passive_fire_register.entries[0];
  assert.equal(entry.location,'North wall, Level 2');
  assert.equal(entry.comments,commentText);
  assert.deepEqual(entry.technical_filters, choices);
  const label = 'North wall, Level 2-Concrete/masonry wall-Plumbing & Hydraulic-Copper Pipes--/90/90';
  await expect(toolbar.locator('option:checked')).toHaveText('001: ' + label);
  await require('./register_plan_location.cjs').pinDrawing(page, register, info.directory);
  const access = form.getByLabel('Is the other side accessible?');
  await access.selectOption('No');
  await expect(comments).toHaveCount(1);
  await expect(comments).toHaveValue(commentText);
  await access.selectOption('Yes');
  await expect(comments).toHaveValue(commentText);
  await expect(toolbar.locator('option:checked')).toHaveText('001 / 001-2: ' + label);
  await expect(form.getByRole('heading',{name:'Side 2'})).toBeVisible();
  await expect(form.getByLabel('ID Number').nth(1)).toHaveValue('001-2');
  await expect(form.getByLabel('ID Number').nth(1)).toHaveJSProperty('readOnly', true);
  await access.selectOption('NA');
  await expect(form.getByRole('heading',{name:'Side 2'})).toHaveCount(0);
  await expect(comments).toHaveValue(commentText);
  await form.getByLabel('Solution').selectOption('Topside only');
  for (const phase of ['Before Photo','During Photo','After Photo','Label Photo']) {
    const pixels = await page.evaluate(label => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 135;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c2ced2'; ctx.fillRect(0,0,400,135);
      ctx.fillStyle = '#1f2526'; ctx.font = '24px sans-serif'; ctx.fillText('Synthetic ' + label,20,80);
      return canvas.toDataURL('image/png').split(',')[1];
    },phase);
    await form.getByLabel(phase,{exact:true}).setInputFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from(pixels,'base64')});
    await expect(form.getByRole('img',{name:phase + ' 1',exact:true})).toBeVisible();
  }
  await setSignerName('Inspection signer');
  let staleSigner = false;
  await page.route('**/api/forms/signer',async route => {
    const response = await route.fetch();
    const profile = await response.json();
    // In Sydney this instant is on the following calendar day.
    await route.fulfill({response,json:{...profile,at:'2026-01-01T15:10:00Z',
      id:staleSigner ? 'other-member' : profile.id}});
  });
  async function drawSignature() {
    await form.getByRole('button',{name:'Insert signature'}).click();
    const box = await page.getByLabel('Signature drawing pad').boundingBox();
    await page.mouse.move(box.x+10,box.y+30);
    await page.mouse.down(); await page.mouse.move(box.x+70,box.y+45,{steps:6}); await page.mouse.up();
    await page.getByRole('dialog').getByRole('button',{name:'Insert signature'}).click();
  }
  await drawSignature();
  await expect(form.getByRole('img',{name:'Signature',exact:true})).toBeVisible();
  await expect(signerName).toHaveValue('Inspection signer');
  await expect(signingDate).toHaveValue('02/01/2026');
  await setSignerName('Updated inspector');
  await form.getByRole('button',{name:'Insert signature'}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
  await expect(signerName).toHaveValue('Inspection signer');
  staleSigner = true;
  await drawSignature();
  await expect(form.getByRole('status')).toHaveText('Your signature profile changed. Reopen the signature pad.');
  await expect(signerName).toHaveValue('Inspection signer');
  staleSigner = false;
  const pdfRoute = '**/api/project/passive-fire-register.pdf';
  let releaseExport, exportStarted;
  const hold = new Promise(resolve => { releaseExport = resolve; });
  const started = new Promise(resolve => { exportStarted = resolve; });
  await page.route(pdfRoute, async route => {
    exportStarted();
    await hold;
    await route.continue();
  });
  const exportReceipt = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/passive-fire-register.pdf');
  await footer.getByRole('button',{name:'Download PDF'}).click();
  try {
    await started;
    await access.selectOption('Yes');
    for (const actions of [toolbar, footer]) await expect(actions.getByRole('button',{name:'Download PDF'})).toBeDisabled();
    await access.selectOption('NA');
  } finally { releaseExport(); }
  const response = await exportReceipt;
  await page.unroute(pdfRoute);
  assert.equal(response.status(),200,await response.text());
  const receipt = await response.json();
  assert.equal(receipt.documentation.item.kind,'passive_fire_register.pdf');
  assert.equal(receipt.documentation.item.filename,'PASSIVE_FIRE_INSPECTIONS-1.pdf');
  assert.equal(path.basename(receipt.path),'PASSIVE_FIRE_INSPECTIONS-1.pdf');
  assert.equal(fs.readFileSync(receipt.path).subarray(0,5).toString(),'%PDF-');
  const signedReportText = await page.evaluate(async url => {
    const lib = await import('/vendor/pdfjs/build/pdf.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
    const loading = lib.getDocument({url});
    try {
      const pdf = await loading.promise;
      const inspection = await pdf.getPage(1);
      const {items} = await inspection.getTextContent();
      return items.map(item => item.str).join(' ').replace(/\s+/g,' ');
    } finally { await loading.destroy(); }
  }, receipt.documentation.item.url);
  assert.match(signedReportText,/Comments Seal checked at the marked location\. Record site condition before signing\. Name Inspection signer/);
  await idle();
  const savedFile = page.locator('#app-message').getByRole('link', {name:receipt.path, exact:true});
  await expect(savedFile).toBeVisible();
  await expect(savedFile).toHaveAttribute('href', receipt.download_url);
  await expect(savedFile).toHaveAttribute('target', '_blank');
  assert.deepEqual(await (await page.request.get(new URL(receipt.download_url, page.url()).href)).body(), fs.readFileSync(receipt.path));
  await downloadRegister(true);
  for (const [kind,filename] of [['passive_fire_register.pdf','PASSIVE_FIRE_INSPECTIONS-1.pdf'],
                                ['passive_fire_registers.pdf','PASSIVE_FIRE_REGISTER-1.pdf']]) {
    const row = page.locator(`tr[data-document-kind="${kind}"]`);
    await row.locator('button[data-revisions-kind]').click();
    const pane = page.locator('#documentation-revisions-pane');
    await expect(pane.getByText(filename,{exact:true})).toBeVisible();
    await pane.getByRole('button',{name:'Close revision history'}).click();
  }
  await register();
  const savedFinal = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save');
  await page.locator('#save-current-project').click();
  assert.equal((await savedFinal).status(),200);
  assert.equal(JSON.parse(fs.readFileSync(info.project)).documentation.revision_count,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(info.project)).passive_fire_register.entries[0].signature_details,
    {member_id:await page.evaluate(() => window.ClassifireAccess.user.id),name:'Inspection signer',date:'2026-01-02'});
  const pins = JSON.parse(fs.readFileSync(info.project)).passive_fire_register.entries[0].plan_pins;
  assert.deepEqual(pins.map(pin => pin.page),[3]);
  assert.ok(Math.abs(pins[0].x - .42)<.02 && Math.abs(pins[0].y - .45)<.02);
  await idle();
  await page.setViewportSize({width:390,height:884});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  for (const width of [390, 1160]) {
    await page.setViewportSize({width, height:884});
    const photos = form.locator('.register-photo-field figure');
    assert.equal(await photos.count(), 4);
    for (const photo of await photos.all()) {
      const image = await photo.locator('img').boundingBox();
      const remove = await photo.getByRole('button',{name:'Remove photo'}).boundingBox();
      assert.ok(remove.x > image.x + image.width);
      assert.ok(Math.abs((image.y + image.height / 2) - (remove.y + remove.height / 2)) < 1);
    }
  }
  await page.setViewportSize({width:390,height:884});
  await page.screenshot({path:path.join(output,'register-mobile.png')});
  await page.setViewportSize({width:1280,height:900});
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({file:'project-b.cf.json'}));
  await createNewProject(page,{client:'Synthetic second register'});
  await register();
  await expect(form.getByLabel('Level/Location')).toHaveValue('');
  await expect(comments).toHaveValue('');
  await expect(form.getByRole('img')).toHaveCount(0);
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({file:'project-a.cf.json'}));
  await openProjectSection(page,'quotes');
  await page.locator('#load-project').click();
  await page.locator('#discard-dialog [value="confirm"]').click();
  await expect(page.locator('#client')).toHaveValue('Synthetic fire register');
  await idle(); await register();
  await expect(form.getByLabel('Level/Location')).toHaveValue('North wall, Level 2');
  await expect(comments).toHaveValue(commentText);
  await expect(form.getByRole('img')).toHaveCount(6);
  await expect(signerName).toHaveValue('Inspection signer');
  await expect(signingDate).toHaveValue('02/01/2026');
  await drawSignature();
  await expect(signerName).toHaveValue('Updated inspector');
  await expect(chosen).toBeChecked();
  await expect(form.locator('.register-plan-mark').first()).toHaveText('001');
  const clear = form.getByRole('button',{name:'Clear signature'});
  assert.deepEqual(await clear.locator('svg path').evaluateAll(paths => paths.map(p => p.getAttribute('d'))),
    await page.locator('#penetration-clear svg path').evaluateAll(paths => paths.map(p => p.getAttribute('d'))));
  const insertBox = await form.getByRole('button',{name:'Insert signature'}).boundingBox(), clearBox = await clear.boundingBox();
  assert.ok(Math.abs(insertBox.y - clearBox.y) < 1 && clearBox.x > insertBox.x + insertBox.width);
  await clear.click();
  await expect(form.getByRole('img',{name:'Signature',exact:true})).toHaveCount(0);
  await expect(signerName).toHaveValue('');
  await expect(signingDate).toHaveValue('');
  assert.equal(await page.evaluate(() => 'signature_details' in window.ClassifirePassiveRegister.capture().value.entries[0]),false);
  const removePhoto = form.getByRole('button',{name:'Remove photo'}).first();
  await expect(removePhoto.locator('.trash-artwork')).toHaveCount(1);
  await removePhoto.click();
  await expect(form.getByRole('img',{name:'Before Photo 1',exact:true})).toHaveCount(0);
  await footer.getByRole('button',{name:'Add entry'}).click();
  await expect(form.getByLabel('ID Number')).toHaveValue('002');
  await expect(comments).toHaveValue('');
  await form.getByLabel('Level/Location').fill('South wall');
  await footer.getByRole('button',{name:'Remove entry'}).click();
  await page.locator('#discard-dialog [value="confirm"]').click();
  await expect(form.getByLabel('Level/Location')).toHaveValue('North wall, Level 2');
  await page.screenshot({path:path.join(output,'register-desktop.png')});
  await toolbar.getByRole('button',{name:'Add entry'}).click();
  await expect(form.getByLabel('ID Number')).toHaveValue('003');
  await downloadRegister(false);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,pdf:receipt.path,project:info.project},null,2));
  console.log('PASS: portable draft, conditional evidence, signed PDF revision and project isolation. ' + output);
}
run().catch(async error => {
  console.error(error,log);
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); server.kill(); });
