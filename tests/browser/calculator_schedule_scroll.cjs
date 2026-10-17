// Real layout/scroll regression: all 1,000 rows must be reachable without
// replacing the bounded renderer with thousands of live controls.
const {chromium, expect: baseExpect} = require('@playwright/test');
const expect = baseExpect.configure({timeout:60000});
const {chooseCalculator} = require('./calculator_actions.cjs');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `calculator-scroll-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data', data=>logs+=data);
const ready = new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[], evidence=[];
const viewport=()=>page.locator('[data-schedule-viewport]');
async function idle(){await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');await page.waitForFunction(()=>!window.CeasefireDesktop.status().busy);}
async function snapshot(){return page.evaluate(()=>window.CeasefireCalculators.projectSnapshot());}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:764}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${info.port}`;
  for(const [id,title,sheet,first,column] of [['steel_vermiculite','Steel (spray)','SCHEDULE',10,'A'],['steel_board','Steel (board)','CALCULATOR',9,'A'],['ductwork','Duct','CALCULATOR',11,'B']]){
    const inputs={[sheet]:Object.fromEntries(Array.from({length:1000},(_,i)=>[`${column}${first+i}`,id==='ductwork'?'400x300':`SCROLL-${i+1}`]))};
    const saved=await page.request.put(`${base}/api/calculators/${id}/state`,{data:{inputs,schedule_rows:Array.from({length:1000},(_,i)=>first+i)}});assert.equal(saved.status(),200);
  }
  await page.goto(base,{waitUntil:'networkidle'});
  for(const [id,title,first,column] of [['steel_vermiculite','Steel (spray)',10,'A'],['steel_board','Steel (board)',9,'A'],['ductwork','Duct',11,'B']]){
    await chooseCalculator(page,title);await expect(page.locator('#calculator-title')).toHaveText(title);await idle();
    const schedule=page.getByRole('button',{name:'SCHEDULE',exact:true});if(await schedule.count())await schedule.click();await idle();
    const before=await snapshot();
    for(const width of [1146,390]){
      await page.setViewportSize({width,height:764});
      const table=viewport().locator('table'),headers=await table.locator('thead th').allTextContents();
      assert.equal(headers[0],'Line');assert.ok(!headers.includes('Row'));assert.equal(headers.at(-1),'Actions');
      const columnCount=headers.length;assert.equal(await table.locator('colgroup col').count(),columnCount);
      const geometry=await viewport().evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,overflow:getComputedStyle(el).overflowY}));
      assert.ok(geometry.height<=764,`${id}: schedule viewport must fit the screen`);
      assert.ok(geometry.scrollHeight>geometry.height,`${id}: schedule must scroll vertically`);
      assert.equal(geometry.overflow,'auto');
      for(const line of [61,500,1000,1]){
        await viewport().evaluate((el,line)=>{el.scrollTop=line===1000?el.scrollHeight:(line-1)*96;},line);
        const control=page.locator(`[data-calculator-cell="${column}${first+line-1}"]`);
        await expect(control).toHaveCount(1);await idle();
        await control.scrollIntoViewIfNeeded();await expect(control).toBeVisible();
        assert.ok(await page.locator('.calculator-virtual-schedule tbody tr:not(.calculator-virtual-spacer)').count()<=60);
        const alignment=await table.locator('tbody tr').evaluateAll((rows,count)=>rows.every(row=>[...row.cells].reduce((total,cell)=>total+cell.colSpan,0)===count),columnCount);
        assert.equal(alignment,true,`${id}/${width}/line ${line}: data and virtual spacer cells align with every visible header`);
        const lineCell=control.locator('xpath=ancestor::tr').locator('td').first();await expect(lineCell).toHaveText(String(line));
        const centred=await lineCell.evaluate(cell=>{const text=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT).nextNode(),range=document.createRange();range.selectNodeContents(text);const ink=range.getBoundingClientRect(),box=cell.getBoundingClientRect();return{alignment:getComputedStyle(cell).textAlign,inkWidth:ink.width,error:Math.abs(ink.x+ink.width/2-box.x-box.width/2)};});
        assert.equal(centred.alignment,'center');assert.ok(centred.inkWidth>0&&centred.error<1,`${id}/${width}/line ${line}: actual virtualized Line text remains centred`);
      }
      assert.deepEqual(await snapshot(),before,'Scrolling must preserve every draft input');
      evidence.push({id,width,...geometry,columns:columnCount,lineIdentityAndSpacerAlignment:true,lineTextCentred:true,lines:[61,500,1000,1]});
    }
    await viewport().evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const last=page.locator(`[data-calculator-cell="${column}${first+999}"]`);await expect(last).toHaveCount(1);await idle();
    const value=id==='ductwork'?'500x350':'EDITED-LINE-1000';await last.fill(value);await last.press('Tab');await idle();
    await viewport().evaluate(el=>{el.scrollTop=0;});await expect(page.locator(`[data-calculator-cell="${column}${first}"]`)).toHaveCount(1);await idle();
    await viewport().evaluate(el=>{el.scrollTop=el.scrollHeight;});await expect(last).toHaveValue(value);await idle();
    await last.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`${id}-line-1000.png`)});
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,errors,evidence},null,2));console.log(`PASS 1,000-row schedule scrolling: ${output}`);
})().catch(async error=>{console.error(error);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
