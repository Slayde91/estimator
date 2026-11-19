const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium,expect} = require('@playwright/test');

async function checkInspectionState(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  try {
    const signerId = 'e8700568-3daf-4f95-8ff1-cf1e1f3c23a2';
    const signature = {version:1,ratio:2,strokes:[[[.1,.3],[.9,.7]]]};
    let staleSigner = true;
    await page.route('**/api/forms/signer',route => route.fulfill({json:{id:staleSigner ? 'different-user' : signerId,
      name:'Synthetic inspector',at:'2026-01-01T15:10:00Z'}}));
    await page.route('**/api/scheduler/bootstrap',route => route.fulfill({json:{user:{id:signerId},timezone:'Australia/Sydney'}}));
    await page.route('http://localhost/inspection-test',route => route.fulfill({contentType:'text/html',body:
      '<section class="view"><div id="duct-inspections-root"></div></section><section class="view"><div id="structural-steel-inspections-root"></div></section>'}));
    const requests = [];
    await page.route('**/api/project/inspection-calculator-rows',async route => {
      const request = route.request().postDataJSON(); requests.push(request);
      const blocked = request.calculator_id === 'steel_board' && request.inputs.estimate !== 'estimate-1' && !request.inputs.updated;
      await route.fulfill({json:{calculator_id:request.calculator_id,
        ...(blocked ? {notes:{10:'The calculator has no reviewed thickness table for this member type, critical temperature and fire period.'}} : {}),rows:[{
        line:10,calculator_id:request.calculator_id,location:'Level 2',duct_size:request.calculator_id === 'ductwork' ? '600 x 400' : '',
        section_id:request.calculator_id === 'ductwork' ? '' : '310UB40.4',critical_temp:550,product:request.calculator_id === 'ductwork' ? 'FyreWrap' : 'Board',
        frl:'120',quantity:2,length:6,report:blocked ? '' : 'Synthetic assessment',
        required_thickness:blocked ? 'N / A' : request.calculator_id === 'ductwork' ? '2 x 38mm' : request.inputs.updated ? '27' : '25'
      }]}});
    });
    await page.goto('http://localhost/inspection-test');
    await page.evaluate(({signerId,signature}) => {
      const translate = (text,args=[]) => text.replace(/\{(\d+)\}/g,(_,index) => args[index] ?? '{'+index+'}');
      window.CeasefireI18n = {translate,text(element,text,args) {element.textContent=translate(text,args);return element;},attr(element,name,text) {element.setAttribute(name,text);}};
      window.CeasefireProject = {changed(){},details(){return {client:'Synthetic'};},openDocumentation(){}};
      window.inspectionEstimate = 'estimate-1';
      window.inspectionEstimates = ['estimate-1','estimate-'+'a'.repeat(32)];
      window.upgradeBoard = false;
      window.CeasefireEstimates = {activeId:()=>window.inspectionEstimate,list:()=>window.inspectionEstimates.map(id=>({id}))};
      window.CeasefireDialogs = {confirm:async()=>true,message(){}};
      window.ClassifireAccess = {user:{id:signerId}};
      window.ClassifirePersonalSignature = {choose:async()=>signature,png:()=>document.createElement('canvas').toDataURL()};
      window.CeasefireCalculators = {captureTakeoffTarget:async()=>({
        inputs:{synthetic:true,estimate:window.inspectionEstimate,updated:window.upgradeBoard},schedule_rows:[10],fingerprint:'current'
      }),projectFingerprint:()=>'current'};
      window.CeasefireDownloads = {save:async(path,payload)=>{window.lastDownload={path,payload};return {saved:true,path:'synthetic.pdf'};}};
      window.ClassifireRegisterPlans = {close(){},exportContext(){return {plan_sessions:{synthetic:'session'}};},section({entry,label,el,optional}) {
        const section=el('section');section.dataset.planLabel=label(entry);section.dataset.optionalPlan=String(optional);return section;
      }};
    },{signerId,signature});
    for (const file of ['dates.js','form-controls.js','calculator-inspections.js']) await page.addScriptTag({path:path.resolve(__dirname,'../../static',file)});
    await page.evaluate(() => window.ClassifireCalculatorInspections.open('steel'));
    const steel = page.locator('#structural-steel-inspections-root');
    await steel.getByRole('checkbox',{name:'Steel (board)',exact:true}).check();
    await expect(steel.getByRole('checkbox',{name:'Steel (board)',exact:true})).toBeChecked();
    await steel.getByLabel('Calculator register row').selectOption('10');
    await expect(steel.locator('tbody')).toContainText('310UB40.4');
    await steel.getByLabel('Reading 1 (mm)',{exact:true}).fill('20');
    await steel.getByRole('button',{name:'Add reading',exact:true}).click();
    await steel.getByLabel('Reading 2 (mm)',{exact:true}).fill('30');
    await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('25');
    await expect(steel.locator('tbody [data-inspection-count]')).toHaveText('2');
    await steel.getByLabel('Reading 2 (mm)',{exact:true}).fill('-1');
    assert.match(await page.evaluate(() => {try {window.ClassifireCalculatorInspections.capture();return '';}catch(error){return error.message;}}),/Enter a thickness/);
    await steel.getByLabel('Reading 2 (mm)',{exact:true}).fill('30');
    const before = await page.evaluate(() => window.ClassifireCalculatorInspections.capture());
    assert.deepEqual(before.value.steel.entries[0].readings,[20,30]);
    assert.equal(before.value.steel.entries[0].source_estimate_id,'estimate-1');
    await page.evaluate(snapshot => window.ClassifireCalculatorInspections.markSaved(snapshot),before);
    assert.equal(await page.evaluate(() => window.ClassifireCalculatorInspections.hasProjectChanges()),false);
    await steel.getByRole('checkbox',{name:'Steel (intumescent)',exact:true}).check();
    await expect(steel.locator('input[name=inspection_steel_method]:checked')).toHaveCount(1);
    await expect(steel.getByRole('checkbox',{name:'Steel (board)',exact:true})).not.toBeChecked();
    // Changing the source method keeps the inspected row snapshot and readings.
    assert.deepEqual(await page.evaluate(() => window.ClassifireCalculatorInspections.capture().value.steel.entries[0]),before.value.steel.entries[0]);
    await steel.getByRole('checkbox',{name:'Steel (intumescent)',exact:true}).click();
    await expect(steel.getByRole('checkbox',{name:'Steel (intumescent)',exact:true})).toBeChecked();
    const picker = steel.getByLabel('Calculator register row');
    await expect(picker.locator('option[value="10"]')).toHaveCount(1);
    await page.evaluate(snapshot => window.ClassifireCalculatorInspections.markSaved(snapshot),before);
    assert.equal(await page.evaluate(() => window.ClassifireCalculatorInspections.hasProjectChanges()),true);

    await steel.getByRole('checkbox',{name:'Steel (board)',exact:true}).check();
    const entryPicker = steel.getByLabel('Register entry');
    const toolbar = steel.locator('.register-toolbar');
    await expect(picker).toHaveValue('10');
    await toolbar.getByRole('button',{name:'Add entry',exact:true}).click();
    await expect(picker.locator('option[value="10"]')).toHaveCount(0);
    await expect(steel.getByText('All calculator rows are assigned to other inspections.')).toBeVisible();
    await entryPicker.selectOption('0');
    await expect(picker).toHaveValue('10');
    await entryPicker.selectOption('1');
    await page.evaluate(() => {
      window.inspectionEstimate='estimate-'+'a'.repeat(32);
      return window.ClassifireCalculatorInspections.open('steel');
    });
    await picker.selectOption('10'); // A matching line in a different estimate remains available.
    await expect(steel.locator('tbody')).toContainText('N / A');
    await expect(steel.getByText('The calculator has no reviewed thickness table', {exact:false})).toBeVisible();
    await steel.getByLabel('Reading 1 (mm)',{exact:true}).fill('35');
    await page.evaluate(() => {window.upgradeBoard=true;});
    await steel.getByRole('button',{name:'Refresh register',exact:true}).click();
    await expect(picker).toHaveValue('saved');
    await expect(steel.locator('tbody')).toContainText('N / A');
    await picker.selectOption('10');
    await expect(steel.getByText('The selected row has no calculated required thickness',{exact:false})).toHaveCount(0);
    await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('35');

    await page.evaluate(() => {
      window.inspectionEstimate='estimate-1';
      return window.ClassifireCalculatorInspections.open('steel');
    });
    await expect(picker.locator('option[value="10"]')).toHaveCount(0);
    await entryPicker.selectOption('0');
    await toolbar.getByRole('button',{name:'Remove entry',exact:true}).click();
    await toolbar.getByRole('button',{name:'Add entry',exact:true}).click();
    await expect(picker.locator('option[value="10"]')).toHaveCount(1);

    const legacy = before.value;
    delete legacy.steel.entries[0].source_estimate_id;
    await page.evaluate(snapshot => {
      window.inspectionEstimates=['estimate-1'];
      window.ClassifireCalculatorInspections.applyProject(snapshot);
      return window.ClassifireCalculatorInspections.open('steel');
    },legacy);
    await expect(picker).toHaveValue('saved');
    await toolbar.getByRole('button',{name:'Add entry',exact:true}).click();
    await expect(picker.locator('option[value="10"]')).toHaveCount(0);

    await page.evaluate(() => window.ClassifireCalculatorInspections.open('duct'));
    const duct = page.locator('#duct-inspections-root');
    await duct.getByLabel('Calculator register row').selectOption('10');
    await expect(duct.locator('tbody')).toContainText('2 x 38mm');
    await duct.getByLabel('Reading 1 (mm)',{exact:true}).fill('61.91');
    const singleReading = await page.evaluate(() => window.ClassifireCalculatorInspections.capture().value);
    await page.evaluate(value => {window.ClassifireCalculatorInspections.applyProject(value);return window.ClassifireCalculatorInspections.open('duct');},singleReading);
    await expect(duct.getByLabel('Reading 1 (mm)',{exact:true})).toHaveValue('61.91');
    await expect(duct.locator('tbody [data-inspection-count]')).toHaveText('1');
    await duct.getByRole('button',{name:'Add reading',exact:true}).click();
    await duct.getByLabel('Reading 2 (mm)',{exact:true}).fill('64.02');
    await expect(duct.locator('tbody [data-inspection-average]')).toHaveText('62.97');
    await expect(duct.locator('tbody [data-inspection-count]')).toHaveText('2');
    await expect(duct.locator('output[data-inspection-average]')).toHaveText('62.97');
    await expect(duct.locator('output[data-inspection-count]')).toHaveText('2');
    await duct.getByRole('button',{name:'Add reading',exact:true}).click();
    await duct.getByLabel('Reading 3 (mm)',{exact:true}).fill('-1');
    await expect(duct.locator('[data-inspection-reading-error]')).toContainText('Enter a thickness');
    await duct.getByRole('button',{name:'Remove reading',exact:true}).nth(2).click();
    await expect(duct.locator('tbody [data-inspection-count]')).toHaveText('2');
    const photoBase64 = await page.evaluate(() => {const canvas=document.createElement('canvas');canvas.width=canvas.height=10;return canvas.toDataURL('image/png').split(',')[1];});
    const photo={name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(photoBase64,'base64')};
    for (const name of ['Before Photos','During Photos','After Photos','Photo of Gauge']) {
      await duct.getByLabel(name,{exact:true}).setInputFiles(photo);
      await page.waitForFunction(() => !window.ClassifireCalculatorInspections.busy());
    }
    await expect(duct.locator('img')).toHaveCount(4);
    await expect(duct.locator('[data-plan-label]')).toHaveAttribute('data-plan-label','001');
    await expect(duct.locator('[data-plan-label]')).toHaveAttribute('data-optional-plan','true');
    await expect(duct.getByLabel('Photo of Gauge',{exact:true})).toHaveAccessibleDescription('Optional');
    const inspectionDate = duct.getByLabel('Inspection date',{exact:true});
    const signerName = duct.getByRole('textbox',{name:'Name',exact:true});
    const signingDate = duct.getByRole('textbox',{name:'Date',exact:true});
    await expect(inspectionDate).toHaveValue('');
    await inspectionDate.fill('2025-12-19');
    await expect(signerName).toHaveJSProperty('readOnly',true);
    await expect(signingDate).toHaveJSProperty('readOnly',true);
    const insertSignature = duct.getByRole('button',{name:'Insert signature',exact:true});
    await insertSignature.click();
    await expect(duct.locator('p[role="status"]')).toHaveText('Your signature profile changed. Reopen the signature pad.');
    await expect(signerName).toHaveValue('');
    staleSigner = false;
    await insertSignature.click();
    await expect(signerName).toHaveValue('Synthetic inspector');
    await expect(signingDate).toHaveValue('02/01/2026');
    await expect(duct.getByRole('img',{name:'Signature',exact:true})).toBeVisible();
    await expect(inspectionDate).toHaveValue('2025-12-19');
    await duct.locator('.register-toolbar').getByRole('button',{name:'Download PDF',exact:true}).click();
    const downloaded = await page.evaluate(() => window.lastDownload);
    assert.equal(downloaded.path,'/api/project/duct-inspections.pdf');
    assert.deepEqual(downloaded.payload.register.entries[0].readings,[61.91,64.02]);
    assert.equal(downloaded.payload.register.entries[0].inspection_date,'2025-12-19');
    assert.deepEqual(downloaded.payload.register.entries[0].signature,signature);
    assert.deepEqual(downloaded.payload.register.entries[0].signature_details,{member_id:signerId,name:'Synthetic inspector',date:'2026-01-02'});
    assert.deepEqual(downloaded.payload.plan_sessions,{synthetic:'session'});
    const snapshot = await page.evaluate(() => window.ClassifireCalculatorInspections.capture().value);
    await page.evaluate(value => {window.ClassifireCalculatorInspections.applyProject(value);return window.ClassifireCalculatorInspections.open('duct');},snapshot);
    await expect(duct.locator('img')).toHaveCount(5);
    await expect(duct.getByLabel('Reading 1 (mm)',{exact:true})).toHaveValue('61.91');
    await expect(duct.getByLabel('Reading 2 (mm)',{exact:true})).toHaveValue('64.02');
    await expect(duct.locator('tbody')).toContainText('2 x 38mm');
    await expect(inspectionDate).toHaveValue('2025-12-19');
    await expect(signingDate).toHaveValue('02/01/2026');
    await duct.getByRole('button',{name:'Clear signature',exact:true}).click();
    await expect(signingDate).toHaveValue('');
    await expect(inspectionDate).toHaveValue('2025-12-19');
    await page.evaluate(() => {window.ClassifireCalculatorInspections.applyProject();return window.ClassifireCalculatorInspections.open('duct');});
    await expect(duct.locator('img')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.ClassifireCalculatorInspections.capture().value),null);
    assert.ok(requests.every(request => JSON.stringify(request.schedule_rows)==='[10]' && request.inputs.synthetic));
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
}
if (require.main === module) {
  (async()=>{const browser=await chromium.launch({headless:true});try {await checkInspectionState(browser);console.log('PASS: calculator inspection selection, readings, photos, snapshot and project isolation');}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
}
module.exports={checkInspectionState};
