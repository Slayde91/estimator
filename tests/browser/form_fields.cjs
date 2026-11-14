'use strict';
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'), path=require('node:path');

(async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    await page.route('https://forms.test/**',route=>route.fulfill(route.request().url().includes('/api/')?
      {json:{user:{id:'s1'}}}:{contentType:'text/html',body:'<main></main>'}));
    await page.goto('https://forms.test/');
    await page.addScriptTag({path:path.resolve(__dirname,'../../static/form-fields.js')});
    await page.addScriptTag({path:path.resolve(__dirname,'../../static/personal-signature.js')});
    await page.addStyleTag({path:path.resolve(__dirname,'../../static/form-fields.css')});
    const template={mode:'workflow',settings:{stages:[{id:'initial'},{id:'review'}]},fields:[
      {id:'layout',type:'section',label:'Inspection'},
      {id:'subject',type:'text',label:'Subject',required:true},
      {id:'toggle',type:'yes_no',label:'Damage?',options:['Yes','No'],explanation_on:['Yes']},
      {id:'detail',type:'textarea',label:'Details',required:true,condition:{field_id:'toggle',value:'Yes'}},
      {id:'impact',type:'choice',label:'Impact',options:['High','Low'],default:'High',condition:{field_id:'toggle',value:'Yes'}},
      {id:'ext',type:'text',label:'Incident reference',condition:{field_id:'impact',value:'High'}},
      {id:'priority',type:'choice',display:'inline',label:'Priority',options:['Normal','Urgent']},
      {id:'tags',type:'multichoice',display:'inline',label:'Tags',options:['New','Old']},
      {id:'crew',type:'person',label:'Crew',multiple:true},{id:'or',type:'lookup',label:'Related form'},
      {id:'range',type:'datetime_range',label:'Shift',timezone:true},
      {id:'draw',type:'sketch',label:'Site sketch',hide_in_pdf:true},{id:'hand',type:'manual_signature',label:'Sign on paper'},
      {id:'photo',type:'photo',label:'Photos',photo_size:'large',show_tags:true,show_description:true},
      {id:'small',type:'photo',label:'Small photo',photo_size:'small',show_tags:true,show_description:true},
      {id:'file',type:'attachment',label:'Document'},
      {id:'place',type:'location',label:'Position'},{id:'act',type:'action',label:'Action'},
      {id:'scan',type:'scan_id',label:'Verify staff ID'},{id:'wallet',type:'staff_wallet',label:'Staff identity'},
      {id:'sign',type:'signature',label:'Employee signature'},{id:'n',type:'counter',label:'Form number'},
      {id:'tab',type:'table',label:'Inventory',columns:[{id:'qty',type:'number',label:'Qty',required:true}]},
      {id:'fixed',type:'table',table_mode:'fixed',label:'Fixed inventory',default:[{count:2}],columns:[
        {id:'count',type:'number',label:'Count',width:'xs'},{id:'at',type:'time',label:'Hour',interval:30,hide_in_pdf:true},
        {id:'code',type:'choice',label:'Code',options:['A','B']},
        {id:'desc',type:'list_property',label:'Product',source_column:'code',mapping:{A:'Apple',B:'Banana'}},
        {id:'price',type:'formula',label:'Price',formula:'=A1*10'},{id:'pdf',type:'attachment',accept:'application/pdf',label:'PDF'},
        {id:'proof',type:'photo',label:'Evidence',photo_size:'xl',show_description:true}]},
      {id:'group',type:'group',label:'Crew checks',children:[{id:'person',type:'person',label:'Worker',required:true}]},
      {id:'locked',type:'text',label:'Review notes',stage_id:'review',default:'future default',required:true}
    ]};
    const options={stageId:'initial',staff:[{id:'s1',name:'Harper'},{id:'s2',name:'Jules'}],member:{id:'s1',name:'Harper'},
      entries:[{id:'r1',name:'Earlier inspection',created_by_name:'Jules'}],
      values:{range:{start:'2026-11-15T01:30+08:00',end:'2026-11-15T05:00+08:00'}}};
    const mount=(opts)=>page.evaluate(({template,opts})=>{
      window.calcCalls=[];
      opts.calculate = answers=>new Promise(resolve=>{
        const count=answers.fixed[0].count;
        window.calcCalls.push({count,finish:()=>resolve({fixed:[{price:String(10*count)}]})});
      });
      window.fields=window.ClassifireFormFields.mount(document.querySelector('main'),template,opts);
    },{template,opts});
    await mount(options);
    const field=id=>page.locator('[data-field-id="'+id+'"]');
    const values=()=>page.evaluate(()=>window.fields.getValues());
    const valid=()=>page.evaluate(()=>window.fields.validate());
    const fixed=field('fixed');
    await expect(fixed.getByRole('button',{name:'Add row'})).toHaveCount(0);
    await expect(fixed.getByRole('button',{name:'Remove'})).toHaveCount(0);
    await expect(fixed.locator('th').first()).toHaveAttribute('data-column-width','xs');
    await page.waitForFunction(()=>window.calcCalls.length===1);
    await field('count').locator('input').fill('7');
    await page.waitForFunction(()=>window.calcCalls.length===2);
    await page.evaluate(()=>window.calcCalls[1].finish());
    await expect(field('price').locator('output')).toHaveText('70');
    await page.evaluate(()=>window.calcCalls[0].finish());
    await expect(field('price').locator('output')).toHaveText('70');
    assert.ok(!Object.hasOwn((await values()).fixed[0],'price'));
    await field('code').locator('select').selectOption('B');
    await expect(field('desc').locator('output')).toHaveText('Banana');
    await expect(field('at').locator('input')).toHaveAttribute('step','1800');
    await field('at').locator('input').fill('09:30');
    await field('pdf').locator('input').setInputFiles({name:'wrong.bin',mimeType:'application/octet-stream',buffer:Buffer.from('bin')});
    await expect(field('pdf')).toContainText('Choose a PDF file.');
    await field('pdf').locator('input').setInputFiles({name:'site.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7')});
    await expect(field('pdf').getByRole('link')).toHaveText('site.pdf');
    assert.equal(await valid(),false);
    await expect(page.getByLabel('Subject')).toBeFocused();
    await page.getByLabel('Subject').fill('<script>Inspection</script>');
    await expect(field('detail')).toBeHidden();
    await expect(field('locked').locator('input')).toHaveCount(0);
    assert.ok(!Object.hasOwn(await values(),'locked'));
    await field('toggle').locator('select').selectOption('Yes');await expect(field('detail')).toBeVisible();
    await expect(field('ext')).toBeVisible();
    await field('toggle').locator('select').selectOption('No');await expect(field('ext')).toBeHidden();
    await field('toggle').locator('select').selectOption('Yes');
    await field('toggle').getByLabel('Explanation').fill('Damaged');
    await field('detail').locator('textarea').fill('Check seal');
    await field('priority').getByLabel('Urgent').check(); await field('tags').getByLabel('Old').check();
    await field('crew').locator('select').selectOption(['s1','s2']);
    await field('or').locator('select').selectOption('r1');
    await field('range').getByLabel('End').fill('2026-11-15T06:00');
    await expect(field('range')).toContainText('UTC+08:00');
    await field('place').getByLabel('Latitude').fill('-33.8');await field('place').getByLabel('Longitude').fill('151.2');
    await field('act').getByLabel('Description').fill('Replace seal');
    await field('act').getByLabel('Assignee').selectOption('s1');
    await field('scan').locator('input').fill('unknown');assert.equal(await valid(),false);
    await field('scan').locator('input').fill('s1');await expect(field('scan')).toContainText('Harper');
    await page.evaluate(()=>localStorage.setItem('ceasefire.takeoff-signature.v1.s1',
      JSON.stringify({version:1,ratio:2,strokes:[[[0,0],[1,1]]]})));
    await field('wallet').locator('input').check();await field('sign').locator('input').check();
    await expect(field('sign').locator('img')).toHaveAttribute('src',/^data:image\/png;base64,/);
    await field('tab').getByRole('button',{name:'Add row'}).click();
    await field('tab').getByRole('table').getByRole('spinbutton').fill('3.5');
    await field('group').getByRole('button',{name:'Add group'}).click();
    await field('group').getByRole('combobox').selectOption('s2');
    await field('file').locator('input').setInputFiles({name:'report.txt',mimeType:'text/plain',buffer:Buffer.from('report')});
    await expect(field('file').getByRole('link')).toHaveText('report.txt');
    await field('hand').getByLabel('Full name').fill('Sid Mills');await field('hand').getByLabel('Company').fill('Mills & Co');
    for(const [id,label,save] of [['draw','Draw sketch','Use sketch'],['hand','Draw signature','Insert signature']]) {
      await field(id).getByRole('button',{name:label}).click();
      const dialog=page.getByRole('dialog'), canvas=dialog.locator('canvas');
      const rect=await canvas.boundingBox();
      await page.mouse.move(rect.x+20,rect.y+20);await page.mouse.down();
      await page.mouse.move(rect.x+50,rect.y+30,{steps:3});await page.mouse.up();
      await dialog.getByRole('button',{name:save}).click();
      await expect(field(id).locator('img')).toHaveAttribute('src',/^data:image\/png;base64,/);
    }
    const media=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
      const paint=canvas.getContext('2d'),stream=canvas.captureStream(12);
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),parts=[];
      const done=new Promise(resolve=>{recorder.onstop=resolve;});
      recorder.ondataavailable=e=>parts.push(e.data);recorder.start();paint.fillRect(0,0,64,64);
      await new Promise(resolve=>setTimeout(resolve,200));recorder.stop();await done;stream.getTracks().forEach(track=>track.stop());
      return [...new Uint8Array(await new Blob(parts,{type:'video/webm'}).arrayBuffer())];
    });
    await field('photo').locator('input').setInputFiles({name:'work.webm',mimeType:'video/webm',buffer:Buffer.from(media)});
    await expect.poll(()=>field('photo').locator('video').evaluate(video=>video.readyState)).toBeGreaterThan(0);
    const png=Buffer.from((await values()).draw.split(',')[1],'base64');
    const upload={name:'photo.png',mimeType:'image/png',buffer:png};
    await field('photo').locator('input').setInputFiles(upload);
    const assets=field('photo').locator('li');
    await expect(assets).toHaveCount(2);
    await assets.first().getByLabel('Tags (one per line)').fill('a'.repeat(81));
    assert.equal(await valid(),false);
    await assets.first().getByLabel('Tags (one per line)').fill(' South stair \nsouth stair\nLevel 3 ');
    await assets.first().getByLabel('Description').fill(' Seal before lining ');
    await assets.last().getByLabel('Description').fill('temporary');await assets.last().getByLabel('Description').fill('');
    await field('proof').locator('input').setInputFiles(upload);
    await field('proof').getByLabel('Description').fill('Cell note');
    await expect(field('proof').getByLabel('Tags (one per line)')).toHaveCount(0);
    await field('small').locator('input').setInputFiles(upload);
    await expect(field('small').getByRole('link')).toHaveText('photo.png');
    await expect(field('small').locator('textarea')).toHaveCount(0);
    assert.equal(await valid(),true);
    const saved=await values();
    assert.deepEqual(saved.photo[0].tags,['South stair','Level 3']);assert.equal(saved.photo[0].description,'Seal before lining');
    assert.deepEqual(Object.keys(saved.photo[1]).sort(),['data','name','type']);
    assert.equal(saved.fixed[0].proof[0].description,'Cell note');
    assert.equal(saved.hand.name,'Sid Mills');assert.equal(saved.hand.company,'Mills & Co');assert.match(saved.hand.image,/^data:image\/png;base64,/);
    assert.deepEqual(saved.toggle,{answer:'Yes',explanation:'Damaged'});
    assert.deepEqual(saved.range,{start:'2026-11-15T01:30+08:00',end:'2026-11-15T06:00+08:00'});
    assert.deepEqual(saved.or,{entry_id:'r1'});assert.deepEqual(saved.tab,[{qty:3.5}]);assert.deepEqual(saved.group,[{person:'s2'}]);
    assert.deepEqual(saved.crew,['s1','s2']);assert.deepEqual(Object.keys(saved.sign),['signature_image']);assert.equal(saved.wallet,true);
    assert.equal(saved.file[0].data,Buffer.from('report').toString('base64'));assert.equal(saved.priority,'Urgent');
    await mount({...options,readOnly:true,values:{...saved,n:14,fixed:[{...saved.fixed[0],price:'70',desc:'Banana'}],sign:{member_name:'Harper',at:'2026-11-15T06:00Z',signature_image:saved.hand.image},
      wallet:{member_name:'Harper',member_id:'s1',role:'editor',at:'2026-11-15T06:00Z'}}});
    await expect(page.locator('main :is(input,select,textarea,button)')).toHaveCount(0);
    await expect(field('wallet')).toContainText('Harper · editor · s1');
    await expect(field('hand')).toContainText('Sid Mills · Mills & Co');await expect(field('sign').locator('img')).toBeVisible();
    await expect(field('price').locator('output')).toHaveText('70');
    assert.equal(await page.evaluate(()=>window.calcCalls.length),0);
    await page.emulateMedia({media:'print'});
    await expect(field('draw')).toBeHidden();await expect(field('hand')).toBeVisible();
    await expect(fixed.getByRole('columnheader',{name:'Hour',includeHidden:true})).toBeHidden();
    await expect(field('photo').locator('video')).toBeHidden();
    await expect(field('photo').getByRole('link')).toHaveText(['work.webm','photo.png']);
    await expect(assets.first()).toContainText('South stair, Level 3');
    await expect(assets.first()).toContainText('Seal before lining');
    await expect(assets.last().locator('.form-photo-metadata')).toHaveCount(0);
    await expect(field('proof')).toContainText('Cell note');
    await expect(field('toggle')).toContainText('Yes · Damaged');await expect(field('n')).toContainText('14');
    assert.equal(await field('subject').locator('script').count(),0);
    await page.emulateMedia({media:'screen'});
    await mount({...options,values:{...saved,hand:{...saved.hand,captured_by:'s1',at:'2026-11-15T06:00Z'}}});
    await expect(field('hand').locator('input,button')).toHaveCount(0);await expect(field('hand')).toContainText('Sid Mills');
    await mount({...options,values:{...saved,hand:saved.hand.image}});
    await expect(field('hand').locator('img')).toBeVisible();await expect(field('hand').locator('input,button')).toHaveCount(0);
    console.log('Forms field collection, validation, workflow locks, attachments, table and read-only display passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
