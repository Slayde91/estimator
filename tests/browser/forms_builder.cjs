const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium, expect} = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://localhost/editor', route => route.fulfill({
      contentType:'text/html', body:'<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main></main></body></html>',
    }));
    await page.goto('http://localhost/editor');
    for (const file of ['styles.css','forms-builder.css','form-fields.css'])
      await page.addStyleTag({path:path.resolve(__dirname,'../../static',file)});
    for (const file of ['form-controls.js','form-rich-text.js','forms-builder.js'])
      await page.addScriptTag({path:path.resolve(__dirname,'../../static',file)});
    await page.evaluate(() => {
      window.editor = window.ClassifireFormsBuilder.mount(document.querySelector('main'), null, {
        staff:[{id:'s1',name:'Inspector One',active:true},{id:'s2',name:'Inspector Two',active:true}],
        onOutline:async () => window.outlineFields,
        onPreview: value => { window.previewed = value; },
        onCancel: () => { window.exited = true; },
        onSave: async value => {
          if (!window.connected) throw Error('Connection unavailable');
          window.saved = value;
          return {...value,version:1};
        },
      });
    });
    const snap = () => page.evaluate(() => window.editor.snapshot());
    const palette = type => page.locator('[data-field-type="'+type+'"]');
    const btn = name => page.getByRole('button',{name,exact:true});
    async function checkRowIcons(row) {
      for (const [name,symbol] of [['Move up','↑'],['Move down','↓']]) {
        const button = row.getByRole('button',{name,exact:true});
        await expect(button).toHaveAttribute('title',name);
        await expect(button.locator('[aria-hidden="true"]')).toHaveText(symbol);
      }
      const remove = row.getByRole('button',{name:'Remove',exact:true});
      await expect(remove).toHaveAttribute('title','Remove');
      await expect(remove.locator('.trash-artwork[aria-hidden="true"]')).toBeVisible();
    }
    const name = page.getByLabel('Template name');
    const applied = await snap();
    for (const [label,symbol] of [['Back','←'],['Undo','↶'],['Redo','↷']]) {
      await expect(btn(label)).toHaveAttribute('title',label);
      await expect(btn(label).locator('.button-symbol[aria-hidden="true"]')).toHaveText(symbol);
    }
    await expect(palette('scan_id')).toHaveCount(0);
    await expect(palette('staff_wallet')).toHaveCount(0);
    await name.fill('Site inspection');
    await palette('choice').dragTo(page.locator('.form-builder-drop-empty'));
    await page.getByLabel('Field label').fill('Weather');
    await expect(page.getByLabel('Help text',{exact:true})).toHaveCount(0);
    const fieldLabel = await page.getByLabel('Field label').boundingBox();
    const requiredBox = await page.getByRole('checkbox',{name:'Required',exact:true}).boundingBox();
    const hiddenBox = await page.getByRole('checkbox',{name:'Hide in printed forms',exact:true}).boundingBox();
    assert.ok(Math.abs(requiredBox.x-hiddenBox.x)<1 && hiddenBox.y >= requiredBox.y+requiredBox.height);
    for (const option of ['Required','Hide in printed forms']) {
      const checkbox = page.getByRole('checkbox',{name:option,exact:true});
      const caption = checkbox.locator('xpath=parent::label/span');
      assert.ok(await caption.evaluate(span => parseFloat(getComputedStyle(span).fontSize) < parseFloat(getComputedStyle(document.body).fontSize)));
      const box = await checkbox.boundingBox();
      assert.ok(box.x > fieldLabel.x + fieldLabel.width && box.y < fieldLabel.y + fieldLabel.height && box.y + box.height > fieldLabel.y);
      await checkbox.check();
    }
    assert.ok((await snap()).fields[0].required && (await snap()).fields[0].hide_in_pdf);
    await page.getByLabel('Choices (one per line)').fill('Wet\nDry');
    await page.getByLabel('List appearance').selectOption('inline');
    await palette('text').click();
    await page.getByLabel('Field label').fill('Wet weather precautions');
    await page.getByLabel('Show field when').selectOption({label:'Weather'});
    await page.getByLabel('Answer is').selectOption('Wet');
    const fields = (await snap()).fields;
    assert.equal(fields.length,2);
    assert.deepEqual(fields[1].condition,{field_id:fields[0].id,value:'Wet'});
    await page.locator('.form-builder-row').last().getByLabel('Move up').click();
    await expect(page.getByRole('alert')).toContainText(/conditional field/);
    assert.deepEqual((await snap()).fields.map(f=>f.id),fields.map(f=>f.id));
    await palette('date').focus();
    await page.keyboard.press('Enter');
    const selector = () => page.locator('.form-builder-field-select');
    await selector().last().dragTo(selector().first(),{targetPosition:{x:10,y:2}});
    assert.deepEqual((await snap()).fields.map(f=>f.type),['date','choice','text']);
    await btn('Undo').click();
    assert.deepEqual((await snap()).fields.map(f=>f.type),['choice','text','date']);
    await btn('Redo').click();
    assert.equal((await snap()).fields[0].type,'date');
    await palette('prefilled_table').click();
    await page.getByLabel('Field label',{exact:true}).fill('Materials');
    await page.getByLabel('Column heading').fill('Quantity');
    await page.getByLabel('Type',{exact:true}).selectOption('number');
    await btn('Default values').click();
    await page.getByLabel('Quantity').fill('4');
    await btn('Fields').click();
    await page.locator('.form-builder-row').last().getByLabel('Duplicate field').click();
    const [original,duplicate] = (await snap()).fields.slice(-2);
    assert.notEqual(original.id,duplicate.id);
    assert.notEqual(original.columns[0].id,duplicate.columns[0].id);
    assert.deepEqual(duplicate.default,[{[duplicate.columns[0].id]:4}]);
    assert.equal(duplicate.table_mode,'fixed');
    const columns = page.locator('.form-builder-nested-row');
    await btn('Add column').click();
    await columns.last().getByLabel('Type',{exact:true}).selectOption('choice');
    await columns.last().getByLabel('Column heading').fill('Product');
    await columns.last().getByLabel('Choices (one per line)').fill('Board\nSealer');
    await btn('Add column').click();
    await columns.last().getByLabel('Type',{exact:true}).selectOption('list_property');
    await columns.last().getByLabel('Board',{exact:true}).fill('10');
    await columns.last().getByLabel('Sealer',{exact:true}).fill('20');
    await btn('Add column').click();
    await columns.last().getByLabel('Type',{exact:true}).selectOption('formula');
    await columns.last().getByLabel('Formula',{exact:true}).fill('=A1*C1');
    await columns.last().getByLabel('Column width').selectOption('xl');
    const derived = (await snap()).fields.at(-1).columns;
    assert.equal(derived[2].source_column,derived[1].id);
    assert.deepEqual(derived[2].mapping,{Board:'10',Sealer:'20'});
    assert.equal(derived[3].formula,'=A1*C1');
    assert.equal(derived[3].width,'xl');
    await btn('Add column').click();
    await columns.last().getByLabel('Type',{exact:true}).selectOption('photo');
    await columns.last().getByLabel('Photo size').selectOption('large');
    await columns.last().getByLabel('Show photo tags').check();
    await columns.last().getByLabel('Show photo description').check();
    await palette('photo').click();
    await expect(page.getByLabel('Show photo tags')).toHaveCount(0);
    await page.getByLabel('Photo size').selectOption('xl');
    await page.getByLabel('Show photo tags').check();
    await page.getByLabel('Photo size').selectOption('small');
    await expect(page.getByLabel('Show photo tags')).toHaveCount(0);
    await page.getByLabel('Photo size').selectOption('large');
    await page.getByLabel('Show photo description').check();
    await palette('expiry_date').click();
    await page.getByLabel('Remind before expiry (days)').fill('7');
    assert.equal((await snap()).fields.at(-1).reminder_days,7);
    await palette('sign_on_table').click();
    assert.deepEqual((await snap()).fields.at(-1).children.map(c=>c.type),['person','datetime','manual_signature']);
    await expect(page.locator('.form-builder-nested-row select option[value="scan_id"]')).toHaveCount(0);
    await expect(page.locator('.form-builder-nested-row select option[value="staff_wallet"]')).toHaveCount(0);
    await checkRowIcons(columns.first());
    const addField = btn('Add group field');
    await expect(addField.locator('.add-symbol[aria-hidden="true"]')).toHaveText('+');
    await expect(addField).toHaveCSS('width','42px');
    await expect(addField).toHaveCSS('height','42px');
    await addField.click();
    await columns.last().getByRole('button',{name:'Move up',exact:true}).click();
    assert.deepEqual((await snap()).fields.at(-1).children.map(c=>c.type),['person','datetime','text','manual_signature']);
    page.once('dialog',dialog=>dialog.accept());
    await columns.nth(2).getByRole('button',{name:'Remove',exact:true}).click();
    assert.deepEqual((await snap()).fields.at(-1).children.map(c=>c.type),['person','datetime','manual_signature']);
    await btn('Settings').click();
    const register = page.getByRole('group',{name:'Form register'});
    const detailsBox = await page.getByRole('group',{name:'Template details',exact:true}).boundingBox();
    const printBox = await page.getByRole('group',{name:'Print layout',exact:true}).boundingBox();
    assert.ok(Math.abs(printBox.x-detailsBox.x)<1 && printBox.y-detailsBox.y-detailsBox.height<=17,
      'Print layout sits directly below Template details regardless of register height');
    await register.getByLabel('Table',{exact:true}).selectOption(duplicate.id);
    await expect(register.getByLabel('Register column').locator('option')).toHaveCount(4);
    await register.getByLabel('Register column').selectOption(derived[3].id);
    await register.getByRole('button',{name:'Add register cell'}).click();
    await register.getByRole('button',{name:'Add register cell'}).click();
    await expect(page.getByRole('alert')).toContainText('already in the register');
    await register.getByLabel('Weather',{exact:true}).check();
    await register.getByLabel('Date',{exact:true}).check();
    await register.getByLabel('Wet weather precautions').check();
    await register.getByLabel('Expiry date').check();
    await register.getByLabel('Register column').selectOption(derived[0].id);
    await register.getByRole('button',{name:'Add register cell'}).click();
    await expect(page.getByRole('alert')).toContainText('up to five');
    await btn('Default values').click();
    const prefilled = page.locator('.form-builder-setting-card').filter({has:page.getByRole('heading',{name:'Materials',exact:true})}).last();
    await prefilled.getByRole('button',{name:'Add prefilled row'}).click();
    await prefilled.locator('tbody tr').first().getByRole('button',{name:'Move down'}).click();
    assert.equal((await snap()).settings.summary_cells[0].row,1);
    await prefilled.locator('tbody tr').first().getByRole('button',{name:'Remove',exact:true}).click();
    assert.equal((await snap()).settings.summary_cells[0].row,0);
    await btn('Settings').click();
    await page.getByLabel('Viewer').check();
    await page.getByLabel('Template ID').fill('QC-01');
    await page.getByLabel('Template type').selectOption('workflow');
    const stages = page.locator('.form-builder-stage');
    await checkRowIcons(stages.first());
    await expect(stages.first().getByRole('button',{name:'Move up',exact:true})).toBeDisabled();
    await btn('Add stage').click();
    const firstStage = (await snap()).settings.stages[0].id;
    await stages.first().getByRole('button',{name:'Move down',exact:true}).click();
    assert.equal((await snap()).settings.stages[1].id,firstStage);
    page.once('dialog',dialog=>dialog.accept());
    await stages.first().getByRole('button',{name:'Remove',exact:true}).click();
    assert.deepEqual((await snap()).settings.stages.map(stage=>stage.id),[firstStage]);
    await btn('Add stage').click();
    await page.getByLabel('Stage name').last().fill('Sign-off');
    await page.getByLabel('Restrict to staff members').last().selectOption('s2');
    await btn('Add condition').last().click();
    await page.getByLabel('Required answer').selectOption('Dry');
    await page.getByLabel('Orientation').selectOption('landscape');
    await page.getByLabel('Include a photo appendix').check();
    await page.getByLabel('Photos per page').selectOption('6');
    await page.getByLabel('Attach reference files').setInputFiles({name:'guide.txt', mimeType:'text/plain',buffer:Buffer.from('Guide')});
    await expect(page.getByText('guide.txt',{exact:true})).toBeVisible();
    await btn('Fields').click();
    await palette('approval').click();
    await page.getByLabel('Workflow stage').selectOption({label:'Sign-off'});
    await btn('Preview').click();
    assert.equal(await page.evaluate(()=>window.previewed.fields.at(-1).stage_id),(await snap()).settings.stages[1].id);
    await btn('Raw code').click();
    const raw = page.getByLabel('Field definitions (JSON)');
    const good = await raw.inputValue();
    await raw.fill('[{}]');
    await btn('Fields').click();
    await expect(raw).toHaveValue('[{}]');
    await expect(page.getByRole('alert')).toContainText('supported field type');
    await raw.fill(good);
    await btn('Apply fields').click();
    await btn('Publish').click();
    await expect(page.getByRole('alert')).toHaveText('Connection unavailable');
    assert.equal(await page.evaluate(()=>window.editor.isDirty()),true);
    await page.evaluate(()=>{ window.connected = true; });
    await btn('Publish').click();
    const saved = await page.evaluate(()=>window.saved);
    assert.equal(saved.status,'published');
    assert.equal(saved.id,applied.id);
    assert.ok(saved.roles.includes('viewer'));
    assert.equal(saved.settings.display_id,'QC-01');
    assert.equal(saved.settings.photos_per_page,6);
    assert.deepEqual(saved.settings.summary_cells,[{field_id:duplicate.id,row:0,column_id:derived[3].id}]);
    assert.equal(saved.settings.summary_fields.length,4);
    const photoColumn=saved.fields.find(f=>f.id===duplicate.id).columns.at(-1);
    assert.ok(photoColumn.show_tags && photoColumn.show_description);
    const photoField=saved.fields.find(f=>f.type==='photo');
    assert.ok(photoField.show_description && !photoField.show_tags);
    assert.deepEqual(saved.settings.stages[1].member_ids,['s2']);
    assert.deepEqual(saved.settings.stages[1].approval_conditions,[{field_id:fields[0].id,value:'Dry'}]);
    assert.equal(saved.settings.attachments[0].data,'data:text/plain;base64,R3VpZGU=');
    assert.equal(await page.evaluate(()=>window.editor.isDirty()),false);
    const count = (await snap()).fields.length;
    await btn('Add from outline').click();
    assert.equal((await snap()).fields.length,count);
    await page.evaluate(()=>{ window.outlineFields = [{id:'device-outline',type:'date',label:'Inspection due'}]; });
    await btn('Add from outline').click();
    assert.equal((await snap()).fields.at(-1).id,'device-outline');
    await btn('Undo').click();
    assert.equal((await snap()).fields.length,count);
    await page.setViewportSize({width:360,height:770});
    await expect(btn('Save changes')).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.evaluate(() => {
      const saved = {id:'legacy-template',name:'Saved staff checks',version:1,status:'published',fields:[
        {id:'staff-check',type:'scan_id',label:'Badge scan',help:'Previously entered description.'},
        {id:'wallet',type:'staff_wallet',label:'Verified identity'},
        {id:'sign-in',type:'group',label:'Staff sign-in',children:[
          {id:'badge',type:'scan_id',label:'Badge'},{id:'nested-wallet',type:'staff_wallet',label:'Staff identity'}]}
      ]};
      window.editor = window.ClassifireFormsBuilder.mount(document.querySelector('main'), saved, {
        onSave: async value => {window.saved = value; return value;}, onCancel:()=>{}, onPreview:()=>{},
      });
    });
    await page.getByLabel('Field label',{exact:true}).fill('Staff badge');
    await expect(page.getByLabel('Help text',{exact:true})).toHaveCount(0);
    await page.locator('.form-builder-field-select').last().click();
    await expect(columns.first().getByLabel('Type',{exact:true})).toHaveValue('scan_id');
    await expect(columns.last().getByLabel('Type',{exact:true})).toHaveValue('staff_wallet');
    await expect(columns.first().locator('option[value="staff_wallet"]')).toHaveCount(0);
    await btn('Save changes').click();
    const [scan,wallet,group] = await page.evaluate(() => window.saved.fields);
    assert.deepEqual(scan,{id:'staff-check',type:'scan_id',label:'Staff badge',help:'Previously entered description.'});
    assert.deepEqual(wallet,{id:'wallet',type:'staff_wallet',label:'Verified identity'});
    assert.equal(group.children[0].type,'scan_id');
    assert.deepEqual(group.children[1],{id:'nested-wallet',type:'staff_wallet',label:'Staff identity'});
    await palette('instruction').click();
    await page.getByLabel('Instructions',{exact:true}).fill('Wear eye protection.');
    assert.equal((await snap()).fields.at(-1).help,'Wear eye protection.');
    await page.getByRole('textbox',{name:'Instructions',exact:true}).press('ControlOrMeta+a');
    await page.getByRole('button',{name:'Bold',exact:true}).click();
    assert.match((await snap()).fields.at(-1).help.html, /<b>Wear eye protection\.<\/b>/i);
    await palette('textarea').click();
    await btn('Default values').click();
    const defaultEditor = page.getByRole('textbox',{name:'Multi-line text',exact:true});
    await defaultEditor.fill('Check after fitting');
    await defaultEditor.press('ControlOrMeta+a');
    await btn('Underline').click();
    assert.match((await snap()).fields.at(-1).default.html, /<u>Check after fitting<\/u>/i);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(pageErrors,[]);
    console.log('Forms editor drag/drop, keyboard order, conditions, workflow, table defaults, role access, attachments, save retry and narrow layout passed.');
  } finally { await browser.close(); }
})().catch(err=>{console.error(err); process.exitCode=1;});
