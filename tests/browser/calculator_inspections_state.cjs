const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium,expect} = require('@playwright/test');

async function checkInspectionState(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  try {
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
    await page.evaluate(() => {
      const translate = (text,args=[]) => text.replace(/\{(\d+)\}/g,(_,index) => args[index] ?? '{'+index+'}');
      window.CeasefireI18n = {translate,text(element,text,args) {element.textContent=translate(text,args);return element;},attr(element,name,text) {element.setAttribute(name,text);}};
      window.CeasefireProject = {changed(){},details(){return {client:'Synthetic'};},openDocumentation(){}};
      window.inspectionEstimate = 'estimate-1';
      window.inspectionEstimates = ['estimate-1','estimate-'+'a'.repeat(32)];
      window.upgradeBoard = false;
      window.CeasefireEstimates = {activeId:()=>window.inspectionEstimate,list:()=>window.inspectionEstimates.map(id=>({id}))};
      window.CeasefireDialogs = {confirm:async()=>true,message(){}};
      window.CeasefireCalculators = {captureTakeoffTarget:async()=>({
        inputs:{synthetic:true,estimate:window.inspectionEstimate,updated:window.upgradeBoard},schedule_rows:[10],fingerprint:'current'
      }),projectFingerprint:()=>'current'};
      window.CeasefireDownloads = {save:async(path,payload)=>{window.lastDownload={path,payload};return {saved:true,path:'synthetic.pdf'};}};
      window.ClassifireRegisterPlans = {close(){},exportContext(){return {plan_sessions:{synthetic:'session'}};},section({entry,label,el}) {const section=el('section');section.dataset.planLabel=label(entry);return section;}};
    });
    for (const file of ['form-controls.js','calculator-inspections.js']) await page.addScriptTag({path:path.resolve(__dirname,'../../static',file)});
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
    await duct.getByLabel('Recorded Thickness (mm)',{exact:true}).fill('76');
    const photoBase64 = await page.evaluate(() => {const canvas=document.createElement('canvas');canvas.width=canvas.height=10;return canvas.toDataURL('image/png').split(',')[1];});
    const photo={name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(photoBase64,'base64')};
    for (const name of ['Before Photos','During Photos','After Photos','Photo of Gauge']) {
      await duct.getByLabel(name,{exact:true}).setInputFiles(photo);
      await page.waitForFunction(() => !window.ClassifireCalculatorInspections.busy());
    }
    await expect(duct.locator('img')).toHaveCount(4);
    await expect(duct.locator('[data-plan-label]')).toHaveAttribute('data-plan-label','001');
    await duct.locator('.register-toolbar').getByRole('button',{name:'Download PDF',exact:true}).click();
    const downloaded = await page.evaluate(() => window.lastDownload);
    assert.equal(downloaded.path,'/api/project/duct-inspections.pdf');
    assert.deepEqual(downloaded.payload.register.entries[0].readings,[76]);
    assert.deepEqual(downloaded.payload.plan_sessions,{synthetic:'session'});
    const snapshot = await page.evaluate(() => window.ClassifireCalculatorInspections.capture().value);
    await page.evaluate(value => {window.ClassifireCalculatorInspections.applyProject(value);return window.ClassifireCalculatorInspections.open('duct');},snapshot);
    await expect(duct.locator('img')).toHaveCount(4);
    await expect(duct.getByLabel('Recorded Thickness (mm)',{exact:true})).toHaveValue('76');
    await expect(duct.locator('tbody')).toContainText('2 x 38mm');
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
